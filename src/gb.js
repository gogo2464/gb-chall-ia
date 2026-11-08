'use strict';
// Headless Game Boy (DMG) emulator core.
// Instruction-level timing: good enough for commercial games like Pokemon Red/Blue.
// Rendering is optional (only used for debug screenshots).

const CPU_HZ = 4194304;
const FRAME_CYCLES = 70224;

const KEY = { A: 0x01, B: 0x02, SELECT: 0x04, START: 0x08, RIGHT: 0x10, LEFT: 0x20, UP: 0x40, DOWN: 0x80 };

const TIMER_BITS = [9, 3, 5, 7];

class GameBoy {
  constructor(rom) {
    if (!rom || rom.length < 0x8000) throw new Error('ROM too small');
    this.rom = new Uint8Array(rom);
    const type = this.rom[0x147];
    if (type === 0x00 || type === 0x08 || type === 0x09) this.mbc = 0;
    else if (type >= 0x01 && type <= 0x03) this.mbc = 1;
    else if (type >= 0x0f && type <= 0x13) this.mbc = 3;
    else if (type >= 0x19 && type <= 0x1e) this.mbc = 5;
    else throw new Error('Unsupported cartridge type 0x' + type.toString(16));
    const ramSizes = { 0: 0, 1: 0x800, 2: 0x2000, 3: 0x8000, 4: 0x20000, 5: 0x10000 };
    const ramSize = ramSizes[this.rom[0x149]] || 0;
    this.eram = new Uint8Array(Math.max(ramSize, 0x2000)).fill(0xff);
    this.eramSize = ramSize;
    this.romBanks = this.rom.length >> 14;

    this.vram = new Uint8Array(0x2000);
    this.wram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xa0);
    this.hram = new Uint8Array(0x7f);
    this.io = new Uint8Array(0x80);

    // MBC state
    this.ramEnabled = false;
    this.romBankLo = 1;
    this.romBankHi = 0;
    this.ramBank = 0;
    this.mbc1Mode = 0;
    this.romOffset = 0x4000;

    // CPU
    this.a = 0x01; this.f = 0xb0; this.b = 0x00; this.c = 0x13;
    this.d = 0x00; this.e = 0xd8; this.h = 0x01; this.l = 0x4d;
    this.sp = 0xfffe; this.pc = 0x0100;
    this.ime = false; this.eiPending = false; this.halted = false;
    this.ie = 0; this.if_ = 0xe1;

    // Timer
    this.divCounter = 0xabcc; this.tima = 0; this.tma = 0; this.tac = 0xf8;

    // PPU
    this.lcdc = 0x91; this.statSel = 0; this.scy = 0; this.scx = 0;
    this.ly = 0; this.lyc = 0; this.bgp = 0xfc; this.obp0 = 0xff; this.obp1 = 0xff;
    this.wy = 0; this.wx = 0; this.mode = 2; this.lineCycles = 0;
    this.statLine = false; this.windowLine = 0;
    this.render = false;
    this.frame = new Uint8Array(160 * 144); // final shades 0..3
    this.bgIdx = new Uint8Array(160);

    // Joypad
    this.keys = 0; this.p1sel = 0x30;

    // Serial
    this.sb = 0; this.sc = 0x7e;
    this.serialActive = false;    // internal-clock (master) transfer running
    this.serialCountdown = 0;
    this.serialReply = -1;        // byte received from partner, -1 = none yet
    this.serialStall = false;     // CPU paused waiting for partner reply
    this.serialRole = null;       // 'master' / 'slave': how the game last used the port
    this.onSerialStart = null;    // (byte) => void, called when we start a master transfer
    this.onSerialByte = null;     // (byte) => void, debug: every byte we send as master

    this.cycles = 0;              // total T-cycles executed
    this.frameCount = 0;
    this.frameCycles = 0;
    this.onFrame = null;          // called at each VBlank (or every 70224 cycles if LCD off)
  }

  // ---------- save RAM ----------
  loadSave(buf) { this.eram.set(new Uint8Array(buf).subarray(0, this.eram.length)); }
  getSave() { return Buffer.from(this.eram.subarray(0, this.eramSize || this.eram.length)); }

  // ---------- memory ----------
  updateRomOffset() {
    let bank;
    if (this.mbc === 1) bank = (this.romBankLo & 0x1f) | (this.romBankHi << 5);
    else bank = this.romBankLo;
    if (this.mbc === 1 && (bank & 0x1f) === 0) bank |= 1;
    bank %= this.romBanks;
    this.romOffset = bank * 0x4000;
  }

  rb(a) {
    if (a < 0x4000) return this.rom[a];
    if (a < 0x8000) return this.rom[this.romOffset + (a - 0x4000)];
    if (a < 0xa000) return this.vram[a - 0x8000];
    if (a < 0xc000) {
      if (!this.ramEnabled || this.eramSize === 0) return 0xff;
      if (this.mbc === 3 && this.ramBank >= 8) return 0; // RTC registers: not emulated
      const bank = (this.mbc === 1 && this.mbc1Mode === 0) ? 0 : (this.ramBank & 0x0f);
      return this.eram[(bank * 0x2000 + (a - 0xa000)) % this.eram.length];
    }
    if (a < 0xe000) return this.wram[a - 0xc000];
    if (a < 0xfe00) return this.wram[a - 0xe000];
    if (a < 0xfea0) return this.oam[a - 0xfe00];
    if (a < 0xff00) return 0xff;
    if (a < 0xff80) return this.readIO(a);
    if (a < 0xffff) return this.hram[a - 0xff80];
    return this.ie;
  }

  wb(a, v) {
    v &= 0xff;
    if (a < 0x8000) return this.mbcWrite(a, v);
    if (a < 0xa000) { this.vram[a - 0x8000] = v; return; }
    if (a < 0xc000) {
      if (!this.ramEnabled || this.eramSize === 0) return;
      if (this.mbc === 3 && this.ramBank >= 8) return;
      const bank = (this.mbc === 1 && this.mbc1Mode === 0) ? 0 : (this.ramBank & 0x0f);
      this.eram[(bank * 0x2000 + (a - 0xa000)) % this.eram.length] = v;
      return;
    }
    if (a < 0xe000) { this.wram[a - 0xc000] = v; return; }
    if (a < 0xfe00) { this.wram[a - 0xe000] = v; return; }
    if (a < 0xfea0) { this.oam[a - 0xfe00] = v; return; }
    if (a < 0xff00) return;
    if (a < 0xff80) return this.writeIO(a, v);
    if (a < 0xffff) { this.hram[a - 0xff80] = v; return; }
    this.ie = v;
  }

  mbcWrite(a, v) {
    if (this.mbc === 0) return;
    if (a < 0x2000) { this.ramEnabled = (v & 0x0f) === 0x0a; return; }
    if (a < 0x4000) {
      if (this.mbc === 1) this.romBankLo = (v & 0x1f) || 1;
      else if (this.mbc === 3) this.romBankLo = (v & 0x7f) || 1;
      else if (this.mbc === 5) {
        if (a < 0x3000) this.romBankLo = (this.romBankLo & 0x100) | v;
        else this.romBankLo = (this.romBankLo & 0xff) | ((v & 1) << 8);
      }
      this.updateRomOffset();
      return;
    }
    if (a < 0x6000) {
      if (this.mbc === 1) { this.romBankHi = v & 3; this.ramBank = v & 3; this.updateRomOffset(); }
      else if (this.mbc === 3) this.ramBank = v;
      else if (this.mbc === 5) this.ramBank = v & 0x0f;
      return;
    }
    if (this.mbc === 1) this.mbc1Mode = v & 1;
    // MBC3 RTC latch: ignored
  }

  readIO(a) {
    switch (a) {
      case 0xff00: {
        let r = 0xc0 | this.p1sel | 0x0f;
        if (!(this.p1sel & 0x10)) r &= ~((this.keys >> 4) & 0x0f);
        if (!(this.p1sel & 0x20)) r &= ~(this.keys & 0x0f);
        return r;
      }
      case 0xff01: return this.sb;
      case 0xff02: return this.sc | 0x7e;
      case 0xff04: return (this.divCounter >> 8) & 0xff;
      case 0xff05: return this.tima;
      case 0xff06: return this.tma;
      case 0xff07: return this.tac | 0xf8;
      case 0xff0f: return this.if_ | 0xe0;
      case 0xff40: return this.lcdc;
      case 0xff41: return 0x80 | this.statSel | (this.ly === this.lyc ? 4 : 0) | ((this.lcdc & 0x80) ? this.mode : 0);
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff46: return this.io[0x46];
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      case 0xff26: return this.io[0x26] | 0x70;
    }
    if (a >= 0xff10 && a <= 0xff3f) return this.io[a - 0xff00];
    return 0xff;
  }

  writeIO(a, v) {
    switch (a) {
      case 0xff00: this.p1sel = v & 0x30; return;
      case 0xff01: this.sb = v; return;
      case 0xff02: this.writeSC(v); return;
      case 0xff04: this.divCounter = 0; return;
      case 0xff05: this.tima = v; return;
      case 0xff06: this.tma = v; return;
      case 0xff07: this.tac = v & 7; return;
      case 0xff0f: this.if_ = v & 0x1f; return;
      case 0xff40: {
        const wasOn = this.lcdc & 0x80;
        this.lcdc = v;
        if (wasOn && !(v & 0x80)) { this.ly = 0; this.lineCycles = 0; this.mode = 0; this.statLine = false; }
        else if (!wasOn && (v & 0x80)) { this.ly = 0; this.lineCycles = 0; this.mode = 2; this.windowLine = 0; this.updateStat(); }
        return;
      }
      case 0xff41: this.statSel = v & 0x78; this.updateStat(); return;
      case 0xff42: this.scy = v; return;
      case 0xff43: this.scx = v; return;
      case 0xff44: return;
      case 0xff45: this.lyc = v; this.updateStat(); return;
      case 0xff46: {
        this.io[0x46] = v;
        const src = v << 8;
        for (let i = 0; i < 0xa0; i++) this.oam[i] = this.rb(src + i);
        return;
      }
      case 0xff47: this.bgp = v; return;
      case 0xff48: this.obp0 = v; return;
      case 0xff49: this.obp1 = v; return;
      case 0xff4a: this.wy = v; return;
      case 0xff4b: this.wx = v; return;
    }
    if (a >= 0xff10 && a <= 0xff3f) this.io[a - 0xff00] = v;
  }

  // ---------- serial ----------
  writeSC(v) {
    this.sc = v & 0x83;
    if (v & 0x80) this.serialRole = (v & 0x01) ? 'master' : 'slave'; // last transfer we armed
    if ((v & 0x81) === 0x81) {
      // We are master (internal clock): start a transfer.
      this.serialActive = true;
      this.serialCountdown = 4096; // 8 bits at 8192 Hz
      this.serialReply = -1;
      if (this.onSerialByte) this.onSerialByte(this.sb);
      if (this.onSerialStart) this.onSerialStart(this.sb);
    } else {
      this.serialActive = false;
      this.serialStall = false;
    }
  }

  // Partner (master) clocks a byte into us. Returns our outgoing byte, or -1 if we
  // were not waiting for an external-clock transfer.
  serialReceive(byte) {
    if ((this.sc & 0x81) !== 0x80) return -1;
    const out = this.sb;
    this.sb = byte & 0xff;
    this.sc &= 0x7f;
    this.if_ |= 0x08;
    return out;
  }

  isSerialSlaveReady() { return (this.sc & 0x81) === 0x80; }

  // Partner's answer to our master transfer.
  serialSupplyReply(byte) {
    if (!this.serialActive) return;
    this.serialReply = byte & 0xff;
    this.serialStall = false;
  }

  serialComplete(byte) {
    this.sb = byte & 0xff;
    this.sc &= 0x7f;
    this.if_ |= 0x08;
    this.serialActive = false;
    this.serialStall = false;
    this.serialReply = -1;
  }

  tickSerial(c) {
    if (!this.serialActive) return;
    this.serialCountdown -= c;
    if (this.serialCountdown > 0) return;
    this.serialCountdown = 0;
    if (this.serialReply >= 0) this.serialComplete(this.serialReply);
    else if (!this.onSerialStart) this.serialComplete(0xff); // nothing plugged in
    else this.serialStall = true; // wait for the partner
  }

  // ---------- joypad ----------
  setKeys(mask) {
    const newly = mask & ~this.keys;
    this.keys = mask & 0xff;
    if (newly) this.if_ |= 0x10;
  }

  // ---------- timer ----------
  tickTimer(c) {
    const old = this.divCounter;
    const nw = old + c;
    this.divCounter = nw & 0xffff;
    if (this.tac & 4) {
      const bit = TIMER_BITS[this.tac & 3] + 1;
      let n = (nw >> bit) - (old >> bit);
      while (n-- > 0) {
        this.tima++;
        if (this.tima > 0xff) { this.tima = this.tma; this.if_ |= 0x04; }
      }
    }
  }

  // ---------- PPU ----------
  updateStat() {
    if (!(this.lcdc & 0x80)) { this.statLine = false; return; }
    const s = this.statSel, m = this.mode;
    const line = ((s & 0x08) && m === 0) || ((s & 0x10) && m === 1) ||
      ((s & 0x20) && m === 2) || ((s & 0x40) && this.ly === this.lyc);
    if (line && !this.statLine) this.if_ |= 0x02;
    this.statLine = !!line;
  }

  frameDone() {
    this.frameCount++;
    this.frameCycles = 0;
    if (this.onFrame) this.onFrame(this);
  }

  tickPPU(c) {
    this.frameCycles += c;
    if (!(this.lcdc & 0x80)) {
      if (this.frameCycles >= FRAME_CYCLES) this.frameDone();
      return;
    }
    this.lineCycles += c;
    for (;;) {
      if (this.ly < 144) {
        if (this.mode === 2 && this.lineCycles >= 80) { this.mode = 3; this.updateStat(); continue; }
        if (this.mode === 3 && this.lineCycles >= 252) {
          if (this.render) this.renderLine();
          this.mode = 0; this.updateStat(); continue;
        }
      }
      if (this.lineCycles >= 456) {
        this.lineCycles -= 456;
        this.ly++;
        if (this.ly === 144) {
          this.mode = 1; this.if_ |= 0x01; this.updateStat(); this.frameDone();
        } else if (this.ly > 153) {
          this.ly = 0; this.windowLine = 0; this.mode = 2; this.updateStat();
        } else {
          if (this.ly < 144) this.mode = 2;
          this.updateStat();
        }
        continue;
      }
      break;
    }
  }

  renderLine() {
    const ly = this.ly, lcdc = this.lcdc, vram = this.vram, out = this.frame, bgIdx = this.bgIdx;
    const row = ly * 160;
    const signedTiles = !(lcdc & 0x10);
    const tileAddr = (t, y) => (signedTiles ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + y * 2;
    if (lcdc & 0x01) {
      const map = (lcdc & 0x08) ? 0x1c00 : 0x1800;
      const y = (ly + this.scy) & 0xff;
      for (let x = 0; x < 160; x++) {
        const px = (x + this.scx) & 0xff;
        const t = vram[map + (y >> 3) * 32 + (px >> 3)];
        const ad = tileAddr(t, y & 7);
        const bit = 7 - (px & 7);
        const ci = ((vram[ad] >> bit) & 1) | (((vram[ad + 1] >> bit) & 1) << 1);
        bgIdx[x] = ci;
        out[row + x] = (this.bgp >> (ci * 2)) & 3;
      }
    } else {
      bgIdx.fill(0);
      out.fill(0, row, row + 160);
    }
    if ((lcdc & 0x20) && (lcdc & 0x01) && this.wy <= ly && this.wx <= 166) {
      const map = (lcdc & 0x40) ? 0x1c00 : 0x1800;
      const wy = this.windowLine++;
      for (let x = Math.max(0, this.wx - 7); x < 160; x++) {
        const px = x - (this.wx - 7);
        const t = vram[map + (wy >> 3) * 32 + (px >> 3)];
        const ad = tileAddr(t, wy & 7);
        const bit = 7 - (px & 7);
        const ci = ((vram[ad] >> bit) & 1) | (((vram[ad + 1] >> bit) & 1) << 1);
        bgIdx[x] = ci;
        out[row + x] = (this.bgp >> (ci * 2)) & 3;
      }
    }
    if (lcdc & 0x02) {
      const hgt = (lcdc & 0x04) ? 16 : 8;
      const list = [];
      for (let i = 0; i < 40 && list.length < 10; i++) {
        const sy = this.oam[i * 4] - 16;
        if (ly >= sy && ly < sy + hgt) list.push(i);
      }
      // lower X wins, then lower OAM index: draw in reverse priority order
      list.sort((p, q) => (this.oam[q * 4 + 1] - this.oam[p * 4 + 1]) || (q - p));
      for (const i of list) {
        const sy = this.oam[i * 4] - 16, sx = this.oam[i * 4 + 1] - 8;
        let tile = this.oam[i * 4 + 2];
        const attr = this.oam[i * 4 + 3];
        let line = ly - sy;
        if (attr & 0x40) line = hgt - 1 - line;
        if (hgt === 16) tile &= 0xfe;
        const ad = tile * 16 + line * 2;
        const pal = (attr & 0x10) ? this.obp1 : this.obp0;
        for (let k = 0; k < 8; k++) {
          const x = sx + k;
          if (x < 0 || x >= 160) continue;
          const bit = (attr & 0x20) ? k : 7 - k;
          const ci = ((vram[ad] >> bit) & 1) | (((vram[ad + 1] >> bit) & 1) << 1);
          if (!ci) continue;
          if ((attr & 0x80) && bgIdx[x]) continue;
          out[row + x] = (pal >> (ci * 2)) & 3;
        }
      }
    }
  }

  tick(c) {
    this.cycles += c;
    this.tickTimer(c);
    this.tickSerial(c);
    this.tickPPU(c);
  }

  // ---------- run loop ----------
  // Runs up to maxCycles. Stops early if waiting on a link-cable reply. Returns cycles run.
  run(maxCycles) {
    let done = 0;
    while (done < maxCycles && !this.serialStall) done += this.step();
    return done;
  }

  runFrame() {
    const start = this.frameCount;
    let done = 0;
    while (this.frameCount === start && done < FRAME_CYCLES * 2 && !this.serialStall) done += this.step();
    return done;
  }

  // ---------- CPU ----------
  fetch() { const v = this.rb(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  push(v) { this.sp = (this.sp - 1) & 0xffff; this.wb(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xffff; this.wb(this.sp, v & 0xff); }
  pop() { const lo = this.rb(this.sp); this.sp = (this.sp + 1) & 0xffff; const hi = this.rb(this.sp); this.sp = (this.sp + 1) & 0xffff; return lo | (hi << 8); }

  get hl() { return (this.h << 8) | this.l; }
  setHL(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }

  getRR(i) { // BC DE HL SP
    switch (i) { case 0: return (this.b << 8) | this.c; case 1: return (this.d << 8) | this.e; case 2: return (this.h << 8) | this.l; default: return this.sp; }
  }
  setRR(i, v) {
    v &= 0xffff;
    switch (i) { case 0: this.b = v >> 8; this.c = v & 0xff; break; case 1: this.d = v >> 8; this.e = v & 0xff; break; case 2: this.h = v >> 8; this.l = v & 0xff; break; default: this.sp = v; }
  }
  getR(i) {
    switch (i) { case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e; case 4: return this.h; case 5: return this.l; case 6: return this.rb(this.hl); default: return this.a; }
  }
  setR(i, v) {
    v &= 0xff;
    switch (i) { case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break; case 4: this.h = v; break; case 5: this.l = v; break; case 6: this.wb(this.hl, v); break; default: this.a = v; }
  }
  cond(i) {
    switch (i) { case 0: return !(this.f & 0x80); case 1: return !!(this.f & 0x80); case 2: return !(this.f & 0x10); default: return !!(this.f & 0x10); }
  }

  alu(op, v) {
    const a = this.a;
    const cy = (this.f >> 4) & 1;
    let r;
    switch (op) {
      case 0: r = a + v; this.f = ((r & 0xff) ? 0 : 0x80) | (((a & 0xf) + (v & 0xf)) > 0xf ? 0x20 : 0) | (r > 0xff ? 0x10 : 0); this.a = r & 0xff; break;
      case 1: r = a + v + cy; this.f = ((r & 0xff) ? 0 : 0x80) | (((a & 0xf) + (v & 0xf) + cy) > 0xf ? 0x20 : 0) | (r > 0xff ? 0x10 : 0); this.a = r & 0xff; break;
      case 2: r = a - v; this.f = ((r & 0xff) ? 0 : 0x80) | 0x40 | ((a & 0xf) < (v & 0xf) ? 0x20 : 0) | (r < 0 ? 0x10 : 0); this.a = r & 0xff; break;
      case 3: r = a - v - cy; this.f = ((r & 0xff) ? 0 : 0x80) | 0x40 | (((a & 0xf) - (v & 0xf) - cy) < 0 ? 0x20 : 0) | (r < 0 ? 0x10 : 0); this.a = r & 0xff; break;
      case 4: this.a = a & v; this.f = (this.a ? 0 : 0x80) | 0x20; break;
      case 5: this.a = a ^ v; this.f = this.a ? 0 : 0x80; break;
      case 6: this.a = a | v; this.f = this.a ? 0 : 0x80; break;
      default: r = a - v; this.f = ((r & 0xff) ? 0 : 0x80) | 0x40 | ((a & 0xf) < (v & 0xf) ? 0x20 : 0) | (r < 0 ? 0x10 : 0); break;
    }
  }

  addSPe() {
    const e = this.fetch();
    const sp = this.sp;
    this.f = (((sp & 0xf) + (e & 0xf)) > 0xf ? 0x20 : 0) | (((sp & 0xff) + e) > 0xff ? 0x10 : 0);
    return (sp + ((e << 24) >> 24)) & 0xffff;
  }

  step() {
    const pending = this.ie & this.if_ & 0x1f;
    if (this.halted) {
      if (!pending) { this.tick(4); return 4; }
      this.halted = false;
    }
    if (this.ime && pending) {
      this.ime = false;
      let i = 0;
      while (!(pending & (1 << i))) i++;
      this.if_ &= ~(1 << i);
      this.push(this.pc);
      this.pc = 0x40 + i * 8;
      this.tick(20);
      return 20;
    }
    if (this.eiPending) { this.eiPending = false; this.ime = true; }
    const op = this.fetch();
    const c = this.exec(op);
    this.tick(c);
    return c;
  }

  exec(op) {
    // LD r,r'
    if (op >= 0x40 && op < 0x80 && op !== 0x76) {
      const src = op & 7, dst = (op >> 3) & 7;
      this.setR(dst, this.getR(src));
      return (src === 6 || dst === 6) ? 8 : 4;
    }
    // ALU A,r
    if (op >= 0x80 && op < 0xc0) {
      const src = op & 7;
      this.alu((op >> 3) & 7, this.getR(src));
      return src === 6 ? 8 : 4;
    }
    if (op < 0x40) {
      const lo = op & 7, r = (op >> 3) & 7;
      if (lo === 4) { // INC r
        const v = (this.getR(r) + 1) & 0xff;
        this.setR(r, v);
        this.f = (this.f & 0x10) | (v ? 0 : 0x80) | ((v & 0xf) === 0 ? 0x20 : 0);
        return r === 6 ? 12 : 4;
      }
      if (lo === 5) { // DEC r
        const v = (this.getR(r) - 1) & 0xff;
        this.setR(r, v);
        this.f = (this.f & 0x10) | 0x40 | (v ? 0 : 0x80) | ((v & 0xf) === 0xf ? 0x20 : 0);
        return r === 6 ? 12 : 4;
      }
      if (lo === 6) { // LD r,d8
        this.setR(r, this.fetch());
        return r === 6 ? 12 : 8;
      }
    }
    switch (op) {
      case 0x00: return 4;
      case 0x01: case 0x11: case 0x21: case 0x31: this.setRR(op >> 4, this.fetch16()); return 12;
      case 0x02: this.wb(this.getRR(0), this.a); return 8;
      case 0x12: this.wb(this.getRR(1), this.a); return 8;
      case 0x22: { const hl = this.hl; this.wb(hl, this.a); this.setHL(hl + 1); return 8; }
      case 0x32: { const hl = this.hl; this.wb(hl, this.a); this.setHL(hl - 1); return 8; }
      case 0x0a: this.a = this.rb(this.getRR(0)); return 8;
      case 0x1a: this.a = this.rb(this.getRR(1)); return 8;
      case 0x2a: { const hl = this.hl; this.a = this.rb(hl); this.setHL(hl + 1); return 8; }
      case 0x3a: { const hl = this.hl; this.a = this.rb(hl); this.setHL(hl - 1); return 8; }
      case 0x03: case 0x13: case 0x23: case 0x33: { const i = op >> 4; this.setRR(i, this.getRR(i) + 1); return 8; }
      case 0x0b: case 0x1b: case 0x2b: case 0x3b: { const i = op >> 4; this.setRR(i, this.getRR(i) - 1); return 8; }
      case 0x09: case 0x19: case 0x29: case 0x39: {
        const hl = this.hl, v = this.getRR(op >> 4), r = hl + v;
        this.f = (this.f & 0x80) | (((hl & 0xfff) + (v & 0xfff)) > 0xfff ? 0x20 : 0) | (r > 0xffff ? 0x10 : 0);
        this.setHL(r);
        return 8;
      }
      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = c ? 0x10 : 0; return 4; }
      case 0x0f: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = c ? 0x10 : 0; return 4; }
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | ((this.f >> 4) & 1)) & 0xff; this.f = c ? 0x10 : 0; return 4; }
      case 0x1f: { const c = this.a & 1; this.a = (this.a >> 1) | (((this.f >> 4) & 1) << 7); this.f = c ? 0x10 : 0; return 4; }
      case 0x08: { const ad = this.fetch16(); this.wb(ad, this.sp & 0xff); this.wb((ad + 1) & 0xffff, this.sp >> 8); return 20; }
      case 0x10: this.fetch(); return 4; // STOP
      case 0x18: { const e = (this.fetch() << 24) >> 24; this.pc = (this.pc + e) & 0xffff; return 12; }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const e = (this.fetch() << 24) >> 24;
        if (this.cond((op >> 3) & 3)) { this.pc = (this.pc + e) & 0xffff; return 12; }
        return 8;
      }
      case 0x27: { // DAA
        let a = this.a, adj = 0, carry = false;
        const n = this.f & 0x40, hf = this.f & 0x20, cf = this.f & 0x10;
        if (!n) {
          if (hf || (a & 0xf) > 9) adj |= 0x06;
          if (cf || a > 0x99) { adj |= 0x60; carry = true; }
          a += adj;
        } else {
          if (hf) adj |= 0x06;
          if (cf) { adj |= 0x60; carry = true; }
          a -= adj;
        }
        a &= 0xff;
        this.a = a;
        this.f = (a ? 0 : 0x80) | n | (carry ? 0x10 : 0);
        return 4;
      }
      case 0x2f: this.a ^= 0xff; this.f |= 0x60; return 4;
      case 0x37: this.f = (this.f & 0x80) | 0x10; return 4;
      case 0x3f: this.f = (this.f & 0x90) ^ 0x10; return 4;
      case 0x76: this.halted = true; return 4;

      case 0xc0: case 0xc8: case 0xd0: case 0xd8:
        if (this.cond((op >> 3) & 3)) { this.pc = this.pop(); return 20; }
        return 8;
      case 0xc9: this.pc = this.pop(); return 16;
      case 0xd9: this.pc = this.pop(); this.ime = true; return 16;
      case 0xc1: case 0xd1: case 0xe1: this.setRR((op >> 4) & 3, this.pop()); return 12;
      case 0xf1: { const v = this.pop(); this.a = v >> 8; this.f = v & 0xf0; return 12; }
      case 0xc5: case 0xd5: case 0xe5: this.push(this.getRR((op >> 4) & 3)); return 16;
      case 0xf5: this.push((this.a << 8) | this.f); return 16;
      case 0xc2: case 0xca: case 0xd2: case 0xda: {
        const ad = this.fetch16();
        if (this.cond((op >> 3) & 3)) { this.pc = ad; return 16; }
        return 12;
      }
      case 0xc3: this.pc = this.fetch16(); return 16;
      case 0xe9: this.pc = this.hl; return 4;
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: {
        const ad = this.fetch16();
        if (this.cond((op >> 3) & 3)) { this.push(this.pc); this.pc = ad; return 24; }
        return 12;
      }
      case 0xcd: { const ad = this.fetch16(); this.push(this.pc); this.pc = ad; return 24; }
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe:
        this.alu((op >> 3) & 7, this.fetch()); return 8;
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff:
        this.push(this.pc); this.pc = op & 0x38; return 16;
      case 0xcb: return this.execCB(this.fetch());
      case 0xe0: this.wb(0xff00 | this.fetch(), this.a); return 12;
      case 0xf0: this.a = this.rb(0xff00 | this.fetch()); return 12;
      case 0xe2: this.wb(0xff00 | this.c, this.a); return 8;
      case 0xf2: this.a = this.rb(0xff00 | this.c); return 8;
      case 0xe8: this.sp = this.addSPe(); return 16;
      case 0xf8: this.setHL(this.addSPe()); return 12;
      case 0xf9: this.sp = this.hl; return 8;
      case 0xea: this.wb(this.fetch16(), this.a); return 16;
      case 0xfa: this.a = this.rb(this.fetch16()); return 16;
      case 0xf3: this.ime = false; this.eiPending = false; return 4;
      case 0xfb: this.eiPending = true; return 4;
      default:
        // Illegal opcode: real hardware locks up. Freeze in place.
        this.pc = (this.pc - 1) & 0xffff;
        this.ime = false;
        this.halted = true;
        this.ie = 0;
        return 4;
    }
  }

  execCB(op) {
    const z = op & 7, y = (op >> 3) & 7;
    const v = this.getR(z);
    switch (op >> 6) {
      case 0: {
        let r, c;
        const cf = (this.f >> 4) & 1;
        switch (y) {
          case 0: c = v >> 7; r = ((v << 1) | c) & 0xff; break;
          case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
          case 2: c = v >> 7; r = ((v << 1) | cf) & 0xff; break;
          case 3: c = v & 1; r = (v >> 1) | (cf << 7); break;
          case 4: c = v >> 7; r = (v << 1) & 0xff; break;
          case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
          case 6: c = 0; r = ((v & 0x0f) << 4) | (v >> 4); break;
          default: c = v & 1; r = v >> 1; break;
        }
        this.setR(z, r);
        this.f = (r ? 0 : 0x80) | (c ? 0x10 : 0);
        return z === 6 ? 16 : 8;
      }
      case 1:
        this.f = (this.f & 0x10) | 0x20 | (((v >> y) & 1) ? 0 : 0x80);
        return z === 6 ? 12 : 8;
      case 2: this.setR(z, v & ~(1 << y)); return z === 6 ? 16 : 8;
      default: this.setR(z, v | (1 << y)); return z === 6 ? 16 : 8;
    }
  }
}

module.exports = { GameBoy, KEY, CPU_HZ, FRAME_CYCLES };
