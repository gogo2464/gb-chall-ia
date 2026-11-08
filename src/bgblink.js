'use strict';
// BGB link-cable protocol (v1.4), see https://bgb.bircd.org/bgblink.html
// Every packet is 8 bytes: b1 (command), b2, b3, b4, i1 (uint32 LE timestamp, 2 MiHz units).
//
// Timing works like BGB: each side sends its own clock (low 31 bits, wrapping) and keeps
// the offset to the peer's clock. When the peer clocks a byte at its time T, we first run
// our emulator up to T, then answer. The pacer (src/pacer.js) also keeps our clock close to
// the peer's, so both consoles stay in step like on a real cable.

const CMD = { VERSION: 1, JOYPAD: 101, SYNC1: 104, SYNC2: 105, SYNC3: 106, STATUS: 108, WANTDISCONNECT: 109 };
const TS_MOD = 0x80000000;
const HALF = 0x40000000;
// Signed difference a - b on the 31-bit wrapping clock.
const tsDiff = (a, b) => ((((a - b) % TS_MOD) + TS_MOD + HALF) % TS_MOD) - HALF;

class BgbLink {
  constructor(socket, gb, { log = () => {}, replyTimeoutMs = 3000, traceBytes = false, timestampEveryMs = 8,
    catchUpCycles = 70224 * 4, lookaheadCycles = 8192 } = {}) {
    this.socket = socket;
    this.gb = gb;
    this.log = log;
    this.replyTimeoutMs = replyTimeoutMs;
    this.traceBytes = traceBytes;
    this.timestampEveryMs = timestampEveryMs;
    this.catchUpCycles = catchUpCycles;      // most we run in one go to reach the peer's time
    this.lookaheadCycles = lookaheadCycles;  // used only when the peer sends no timestamps
    this.buf = Buffer.alloc(0);
    this.masterSentAt = 0;
    this.onActivity = () => {};
    this.closed = false;
    this.timer = null;
    // Peer clock tracking (all in our timestamp units = cycles / 2).
    this.offset = null;          // ourTs - peerTs, fixed at the first peer timestamp
    this.peerTsLocal = 0;        // peer's latest time, expressed on our clock
    this.peerTsAt = 0;           // performance.now() when we received it
    this.stats = { bytesIn: 0, bytesOut: 0, acksSent: 0, acksReceived: 0, replyTimeouts: 0, maxReplyMs: 0, versionMismatch: 0, resyncs: 0 };

    gb.onSerialStart = (byte) => this.masterStart(byte);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.stop());
    socket.setNoDelay(true);
  }

  get bytesIn() { return this.stats.bytesIn; }
  get bytesOut() { return this.stats.bytesOut; }

  start() {
    this.send(CMD.VERSION, 1, 4, 0, 0);
    this.timer = setInterval(() => this.send(CMD.SYNC3, 0, 0, 0, this.timestamp()), this.timestampEveryMs);
  }

  stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  timestamp() { return Math.floor(this.gb.cycles / 2) % TS_MOD; }

  // Record the peer's clock. Returns the peer time expressed on our clock.
  notePeerTs(ts) {
    const ours = this.timestamp();
    if (this.offset === null) this.offset = tsDiff(ours, ts);
    let local = (ts + this.offset + TS_MOD) % TS_MOD;
    // If the clocks drifted far apart (peer paused, slow machine...), re-anchor.
    const ahead = tsDiff(local, ours);
    if (Math.abs(ahead) > 4194304 * 2) { // more than ~4 s apart
      this.offset = tsDiff(ours, ts);
      local = ours;
      this.stats.resyncs++;
    }
    this.peerTsLocal = local;
    this.peerTsAt = performance.now();
    return local;
  }

  // For the pacer: how many cycles we may run now to stay in step with the peer.
  // null = the peer sends no timestamps, pace on the wall clock alone.
  // We follow the peer's last real timestamp; we only guess ahead from the wall clock when
  // the peer has gone quiet for more than `staleMs` (e.g. it sends timestamps rarely).
  cyclesUntilPeer(nowMs, cyclesPerMs, slackCycles, staleMs = 40) {
    if (this.offset === null) return null;
    const quietMs = Math.max(0, nowMs - this.peerTsAt - staleMs);
    const peerNow = this.peerTsLocal + (quietMs * cyclesPerMs) / 2;
    return tsDiff(Math.floor(peerNow) % TS_MOD, this.timestamp()) * 2 + slackCycles;
  }

  send(b1, b2, b3, b4, i1) {
    if (this.closed || this.socket.destroyed) return;
    const p = Buffer.alloc(8);
    p[0] = b1; p[1] = b2 & 0xff; p[2] = b3 & 0xff; p[3] = b4 & 0xff;
    p.writeUInt32LE(i1 >>> 0, 4);
    this.socket.write(p);
  }

  // Our game started an internal-clock transfer: ask the peer for its byte.
  masterStart(byte) {
    this.masterSentAt = Date.now();
    this.stats.bytesOut++;
    if (this.traceBytes) this.log('tx_master', { byte });
    this.send(CMD.SYNC1, byte, 0x81, 0, this.timestamp());
  }

  masterReplied(byte) {
    const ms = Date.now() - this.masterSentAt;
    if (ms > this.stats.maxReplyMs) this.stats.maxReplyMs = ms;
    this.gb.serialSupplyReply(byte);
    this.onActivity();
  }

  checkTimeout() {
    const gb = this.gb;
    if (gb.serialActive && gb.serialReply < 0 && Date.now() - this.masterSentAt > this.replyTimeoutMs) {
      this.stats.replyTimeouts++;
      if (this.stats.replyTimeouts <= 5) this.log('link_reply_timeout', { afterMs: Date.now() - this.masterSentAt });
      gb.serialSupplyReply(0xff);
    }
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 8) {
      const p = this.buf.subarray(0, 8);
      this.buf = this.buf.subarray(8);
      this.handle(p[0], p[1], p[2], p[3], p.readUInt32LE(4));
    }
    if (this.buf.length) this.buf = Buffer.from(this.buf);
  }

  // Peer clocks a byte into us at its time `ts`.
  // First run our emulator up to that moment, EVEN IF our port is already listening: the
  // game re-arms the port in its interrupt and reads the previous byte a little later in
  // its main loop. Delivering the next byte before we reach the sender's time overwrites a
  // byte the game has not read yet (all bytes arrive, but the game skips some).
  slaveTransfer(byte, ts) {
    const gb = this.gb;
    if (ts && !gb.serialActive) {
      const target = this.notePeerTs(ts);
      const limit = Math.min(this.catchUpCycles, Math.max(0, tsDiff(target, this.timestamp()) * 2));
      let n = 0;
      while (n < limit && !gb.serialStall) n += gb.step();
    }
    let out = gb.serialReceive(byte);
    if (out < 0 && !ts && !gb.serialActive) {
      // Peer without timestamps: small fixed lookahead in case we are about to listen.
      let n = 0;
      while (n < this.lookaheadCycles && !gb.isSerialSlaveReady() && !gb.serialStall) n += gb.step();
      out = gb.serialReceive(byte);
    }
    return out;
  }

  handle(b1, b2, b3, b4, i1) {
    const gb = this.gb;
    switch (b1) {
      case CMD.VERSION:
        if (b2 !== 1 || b3 !== 4) {
          this.stats.versionMismatch++;
          this.log('bgb_version_mismatch', { major: b2, minor: b3 });
        }
        this.send(CMD.STATUS, 0x01, 0, 0, 0); // status goes in response to version
        break;
      case CMD.SYNC1: {
        this.stats.bytesIn++;
        const out = this.slaveTransfer(b2, i1);
        if (this.traceBytes) this.log('rx_slave', { byte: b2, reply: out < 0 ? 'ack' : out });
        if (out < 0) { this.stats.acksSent++; this.send(CMD.SYNC3, 1, 0, 0, 0); } // not listening
        else this.send(CMD.SYNC2, out, 0x80, 0, 0);
        this.onActivity();
        break;
      }
      case CMD.SYNC2:
        if (this.traceBytes) this.log('rx_master_reply', { byte: b2 });
        this.masterReplied(b2);
        break;
      case CMD.SYNC3:
        if (b2 === 1) { // ack: peer was not listening, so the line reads high
          this.stats.acksReceived++;
          if (gb.serialActive && gb.serialReply < 0) this.masterReplied(0xff);
        } else if (i1) {
          this.notePeerTs(i1);
          this.onActivity();
        }
        break;
      case CMD.STATUS:
      case CMD.JOYPAD:
        break;
      case CMD.WANTDISCONNECT:
        this.socket.end();
        break;
      default:
        this.log('bgb_unknown_packet', { b1 });
    }
  }
}

module.exports = { BgbLink, CMD, tsDiff };
