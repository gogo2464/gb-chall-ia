'use strict';
// Offline end-to-end test: two emulators, both driven by the trade bot, connected by a
// virtual link cable. If everything works they meet in the Trade Center and trade.
//   node tools/linktest.js --rom roms/pokered.gb --sav roms/pokered.sav [--sav2 other.sav] --seconds 240
const fs = require('fs');
const path = require('path');
const { GameBoy } = require('../src/gb');
const { TradeBot } = require('../src/bot');
const { frameToPng } = require('../src/png');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const rom = fs.readFileSync(opt('rom', 'roms/pokered.gb'));
const readSav = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : (console.warn('no save:', p), new Uint8Array(0)));
const savA = readSav(opt('sav', 'roms/pokered.sav'));
const savB = readSav(opt('sav2', opt('sav', 'roms/pokered.sav')));
const seconds = Number(opt('seconds', 240));
const out = opt('out', 'shots-linktest');
fs.mkdirSync(out, { recursive: true });

function make(name, sav, startDelayFrames) {
  const gb = new GameBoy(rom);
  gb.loadSave(sav);
  gb.render = true;
  const bot = new TradeBot({ log: (e, d) => console.log(`[${name}] ${e} ${JSON.stringify(d)}`) });
  let wait = startDelayFrames;
  gb.onFrame = (g) => { if (wait > 0) { wait--; g.setKeys(0); } else bot.onFrame(g); };
  gb.onSerialStart = () => {}; // replies are resolved by the cable below
  return { gb, bot, name };
}

// Small offset so the two consoles are not perfectly in phase (like real life).
const A = make('A', savA, 0);
const B = make('B', savB, 37);

// Virtual cable: when a master's 8 bits are done, swap bytes with the partner if it listens.
function resolve(m, s) {
  if (!m.gb.serialStall) return;
  const r = s.gb.serialReceive(m.gb.sb);
  m.gb.serialSupplyReply(r < 0 ? 0xff : r);
}

const SLICE = 456;
const total = Math.round(seconds * 4194304);
const t0 = Date.now();
let ran = 0, nextShot = 0;
while (ran < total) {
  A.gb.run(SLICE); resolve(A, B);
  B.gb.run(SLICE); resolve(B, A);
  ran += SLICE;
  if (ran >= nextShot) {
    const s = String(Math.round(ran / 4194304)).padStart(4, '0');
    fs.writeFileSync(path.join(out, `A-${s}s.png`), frameToPng(A.gb.frame));
    fs.writeFileSync(path.join(out, `B-${s}s.png`), frameToPng(B.gb.frame));
    nextShot += 10 * 4194304;
  }
}
console.log(`done in ${Date.now() - t0} ms. trades: A=${A.bot.trades} B=${B.bot.trades}. screenshots in ${path.resolve(out)}`);
process.exit(A.bot.trades > 0 && B.bot.trades > 0 ? 0 : 1);
