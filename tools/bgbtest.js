'use strict';
// End-to-end network test: a bot-driven emulator connects to the server over the BGB
// protocol, exactly like a player would with BGB.
//   SPEED=10 node src/server.js          (in one terminal)
//   node tools/bgbtest.js --speed 10 --seconds 60 [--host 127.0.0.1 --port 8765]
const fs = require('fs');
const net = require('net');
const { GameBoy } = require('../src/gb');
const { startPacer } = require('../src/pacer');
const { TradeBot } = require('../src/bot');
const { BgbLink } = require('../src/bgblink');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const speed = Number(opt('speed', 1));
const seconds = Number(opt('seconds', 120));

const log = (e, d) => console.log(`[client] ${e} ${JSON.stringify(d).slice(0, 200)}`);
const gb = new GameBoy(fs.readFileSync(opt('rom', 'roms/pokered.gb')));
gb.loadSave(fs.readFileSync(opt('sav', 'roms/pokered.sav')));
const bot = new TradeBot({ log });
if (opt('shot')) gb.render = true;
// --human-delay N: once the link is up at the receptionist, stop pressing buttons for N game
// seconds, like a person reading the "we have to save the game" text before pressing YES.
const humanDelayFrames = Math.round(Number(opt('human-delay', 0)) * 59.73);
let waited = 0;
gb.onFrame = (g) => {
  const connected = g.rb(0xffaa) === 1 || g.rb(0xffaa) === 2;
  if (humanDelayFrames && connected && g.rb(0xd35e) !== 0xef && waited < humanDelayFrames) {
    if (waited++ === 0) log('human_delay', { seconds: Number(opt('human-delay')) });
    g.setKeys(0);
    return;
  }
  bot.onFrame(g);
};

// --boot N: run N frames at full speed before connecting (changes who ends up master).
// Default: a random amount, so the client is never perfectly in phase with the server bot.
const bootFrames = Number(opt('boot', 1200 + Math.floor(Math.random() * 600)));
for (let i = 0; i < bootFrames; i++) gb.runFrame();

const sock = net.connect(Number(opt('port', 8765)), opt('host', '127.0.0.1'), () => {
  const link = new BgbLink(sock, gb, { log });
  link.start();
  startPacer(gb, link, { speed }); // same rule as BGB: follow the peer while receiving
  setTimeout(() => {
    console.log(`[client] done: trades=${bot.trades} ${JSON.stringify(link.stats)} clock=${gb.rb(0xffaa)}`);
    if (opt('shot')) fs.writeFileSync(opt('shot'), require('../src/png').frameToPng(gb.frame));
    process.exit(bot.trades > 0 ? 0 : 1);
  }, seconds * 1000);
});
sock.on('error', (e) => { console.error(e.message); process.exit(1); });
