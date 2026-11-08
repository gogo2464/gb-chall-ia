'use strict';
// TCP server: every connection gets its own child process running a fresh
// Pokemon Red emulator parked in the Cable Club, speaking the BGB link protocol.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const cfg = require('./config');

if (!fs.existsSync(cfg.romPath)) {
  console.error(`ROM not found: ${cfg.romPath} (set ROM_PATH)`);
  process.exit(1);
}

let active = 0;
let nextId = 1;
const perIp = new Map();
const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

const server = net.createServer({ pauseOnConnect: true }, (socket) => {
  const ip = socket.remoteAddress || '?';
  const peer = `${ip}:${socket.remotePort}`;
  const ipCount = perIp.get(ip) || 0;
  if (active >= cfg.maxSessions || ipCount >= cfg.maxPerIp) {
    log('rejected', { peer, active, ipCount });
    socket.destroy();
    return;
  }
  const sid = nextId++;
  active++;
  perIp.set(ip, ipCount + 1);
  log('connect', { sid, peer, active });

  const child = fork(path.join(__dirname, 'session.js'), [], {
    execArgv: ['--max-old-space-size=96'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const release = () => {
    active--;
    const n = (perIp.get(ip) || 1) - 1;
    if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
  };
  child.once('exit', (code) => { release(); log('session_exit', { sid, code, active }); });
  child.send({ type: 'socket', sid, peer }, socket);
  // Hard kill in case the child hangs.
  setTimeout(() => child.kill('SIGKILL'), (cfg.sessionTimeoutS + 30) * 1000).unref();
});

server.listen(cfg.port, cfg.host, () => {
  log('listening', { host: cfg.host, port: cfg.port, rom: cfg.romPath, save: fs.existsSync(cfg.savePath) ? cfg.savePath : null });
});
