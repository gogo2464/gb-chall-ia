'use strict';
// Run the ROM headless and dump screenshots. Useful to check your save boots to the receptionist.
//   node tools/run.js --rom roms/pokered.gb --sav roms/pokered.sav --seconds 30 --out shots
// Options: --no-bot (no inputs), --serial (print bytes the ROM sends over serial, e.g. blargg tests)
const fs = require('fs');
const path = require('path');
const { GameBoy } = require('../src/gb');
const { TradeBot, readParty, ADDR } = require('../src/bot');
const { frameToPng } = require('../src/png');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);

const gb = new GameBoy(fs.readFileSync(opt('rom', 'roms/pokered.gb')));
const sav = opt('sav', 'roms/pokered.sav');
if (fs.existsSync(sav)) gb.loadSave(fs.readFileSync(sav));
gb.render = true;
const out = opt('out', 'shots');
fs.mkdirSync(out, { recursive: true });
const seconds = Number(opt('seconds', 30));
const every = Number(opt('every', 5));

if (flag('serial')) {
  let line = '';
  gb.onSerialByte = (b) => {
    if (b === 10) { console.log(line); line = ''; } else line += String.fromCharCode(b);
  };
}
if (!flag('no-bot')) {
  const bot = new TradeBot({ log: (e, d) => console.log(e, JSON.stringify(d)) });
  gb.onFrame = (g) => bot.onFrame(g);
}

const t0 = Date.now();
const frames = Math.round(seconds * 59.73);
for (let f = 1; f <= frames; f++) {
  gb.runFrame();
  if (f % Math.round(every * 59.73) === 0 || f === frames) {
    const file = path.join(out, `t${String(Math.round(f / 59.73)).padStart(4, '0')}s.png`);
    fs.writeFileSync(file, frameToPng(gb.frame));
  }
}
const ms = Date.now() - t0;
console.log(`ran ${frames} frames in ${ms} ms (${(frames / 59.73 / (ms / 1000)).toFixed(1)}x real time)`);
console.log('map', gb.rb(ADDR.wCurMap).toString(16), 'linkState', gb.rb(ADDR.wLinkState).toString(16));
if (gb.rb(ADDR.wPartyCount) <= 6) console.log('party', JSON.stringify(readParty(gb)));
console.log('screenshots in', path.resolve(out));
