'use strict';
const path = require('path');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));
const root = path.join(__dirname, '..');

module.exports = {
  romPath: path.resolve(root, env('ROM_PATH', 'roms/pokered.gb')),
  savePath: path.resolve(root, env('SAVE_PATH', 'roms/pokered.sav')),
  host: env('HOST', '0.0.0.0'),
  port: num('PORT', 8765),                       // BGB's default link port
  maxSessions: num('MAX_SESSIONS', 16),
  maxPerIp: num('MAX_PER_IP', 2),
  sessionTimeoutS: num('SESSION_TIMEOUT', 900),
  bootFrames: num('BOOT_FRAMES', 1200),          // frames run at full speed before accepting link traffic
  speed: num('SPEED', 1),                        // 1 = real time
  linkReplyTimeoutMs: num('LINK_REPLY_TIMEOUT_MS', 3000),
  screenshotDir: env('SCREENSHOT_DIR', ''),      // debug: write PNGs of each session here
  screenshotEveryS: num('SCREENSHOT_EVERY', 5),
  traceBytes: env('TRACE_BYTES', '0') === '1',   // debug: log every link byte
  // auto = stay behind the player's clock while our game receives link bytes (like BGB)
  linkFollow: ({ auto: 'auto', 1: true, 0: false })[env('LINK_FOLLOW', 'auto')] ?? 'auto',
};
