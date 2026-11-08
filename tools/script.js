'use strict';
// Replay a button script on top of a save, then screenshot / export the battery save.
// Useful to build the "parked at the Cable Club" save from any save.
//   node tools/script.js --script "S D A ..." [--out shot.png] [--export new.sav]
// Tokens: A B S(tart) E(select) U D L R = tap (turns / menu moves),
//         u3 d1 l2 r4 = walk N tiles, W60 = wait 60 frames.
// Boot: mashes A for --boot frames (CONTINUE), then B a few times to close dialogs.
const fs = require('fs');
const { GameBoy, KEY } = require('../src/gb');
const { frameToPng } = require('../src/png');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const gb = new GameBoy(fs.readFileSync(opt('rom', 'roms/pokered.gb')));
gb.loadSave(fs.readFileSync(opt('sav', 'roms/pokered.sav')));
gb.render = true;

const frames = (n, keys = 0) => { for (let i = 0; i < n; i++) { gb.setKeys(keys); gb.runFrame(); } };
const tap = (k) => { frames(6, k); frames(14); };

const bootFrames = Number(opt('boot', 700));
for (let i = 0; i < bootFrames; i += 12) { frames(6, KEY.A); frames(6); }
for (let i = 0; i < 4; i++) tap(KEY.B);
frames(60);

const TAP = { A: KEY.A, B: KEY.B, S: KEY.START, E: KEY.SELECT, U: KEY.UP, D: KEY.DOWN, L: KEY.LEFT, R: KEY.RIGHT };
const WALK = { u: KEY.UP, d: KEY.DOWN, l: KEY.LEFT, r: KEY.RIGHT };
for (const tok of (opt('script', '')).split(/\s+/).filter(Boolean)) {
  const c = tok[0], n = Number(tok.slice(1) || 1);
  if (c === 'W') frames(n);
  else if (TAP[c]) for (let i = 0; i < n; i++) tap(TAP[c]);
  else if (WALK[c]) { frames(16 * n, WALK[c]); frames(20); }
  else throw new Error('bad token ' + tok);
}

const r = (a) => gb.rb(a);
const facing = { 0: 'down', 4: 'up', 8: 'left', 12: 'right' }[r(0xc109)];
console.log(`map 0x${r(0xd35e).toString(16)} x=${r(0xd362)} y=${r(0xd361)} facing=${facing} linkState=${r(0xd12b)}`);
if (opt('out')) fs.writeFileSync(opt('out'), frameToPng(gb.frame));
if (opt('export')) { fs.writeFileSync(opt('export'), gb.getSave()); console.log('exported', opt('export')); }
