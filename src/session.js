'use strict';
// One player connection = one child process = one fresh emulator.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { GameBoy } = require('./gb');
const { startPacer } = require('./pacer');
const { TradeBot } = require('./bot');
const { BgbLink } = require('./bgblink');
const { frameToPng } = require('./png');

function createEmulator(log) {
  const gb = new GameBoy(fs.readFileSync(cfg.romPath));
  if (fs.existsSync(cfg.savePath)) gb.loadSave(fs.readFileSync(cfg.savePath));
  else log('warning', { msg: 'no save file, the game will start from scratch: ' + cfg.savePath });
  const bot = new TradeBot({ log });
  gb.onFrame = (g) => bot.onFrame(g);
  if (cfg.screenshotDir) gb.render = true;
  return { gb, bot };
}

function runSession(socket, meta) {
  const log = (event, data = {}) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), sid: meta.sid, peer: meta.peer, event, ...data }));
  let finished = false;
  const finish = (why) => {
    if (finished) return;
    finished = true;
    if (link) link.stop();
    log('session_end', { why, trades: bot.trades, link: link && link.stats });
    if (pacer) pacer.stop();
    clearInterval(shotTimer);
    socket.destroy();
    setTimeout(() => process.exit(0), 50);
  };

  let link = null;
  let pacer = null;
  const { gb, bot } = createEmulator(log);

  // Boot at full speed with no cable plugged in: title screen -> CONTINUE -> overworld.
  const t0 = Date.now();
  for (let i = 0; i < cfg.bootFrames; i++) gb.runFrame();
  log('booted', { frames: cfg.bootFrames, ms: Date.now() - t0 });

  link = new BgbLink(socket, gb, { log, replyTimeoutMs: cfg.linkReplyTimeoutMs, traceBytes: cfg.traceBytes });
  socket.on('close', () => finish('peer closed'));
  socket.on('error', (e) => finish('socket error: ' + e.message));
  link.start();
  socket.resume();

  // Real-time pacing, kept in step with the player's clock.
  pacer = startPacer(gb, link, { speed: cfg.speed, follow: cfg.linkFollow });

  let shotTimer = null;
  if (cfg.screenshotDir) {
    fs.mkdirSync(cfg.screenshotDir, { recursive: true });
    shotTimer = setInterval(() => {
      fs.writeFile(path.join(cfg.screenshotDir, `session-${meta.sid}.png`), frameToPng(gb.frame), () => {});
    }, cfg.screenshotEveryS * 1000);
  }

  setTimeout(() => finish('timeout'), cfg.sessionTimeoutS * 1000).unref();
}

process.on('message', (msg, socket) => {
  if (msg && msg.type === 'socket' && socket) {
    try { runSession(socket, msg); } catch (e) {
      console.error(JSON.stringify({ sid: msg.sid, event: 'crash', error: String(e && e.stack || e) }));
      socket.destroy();
      process.exit(1);
    }
  }
});

module.exports = { createEmulator };
