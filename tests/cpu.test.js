'use strict';
// Self-contained CPU/hardware checks with hand-assembled programs.  node tests/cpu.test.js
const assert = require('assert');
const { GameBoy } = require('../src/gb');

// Build a 64 KiB MBC3 ROM with `code` at 0x150 and optional extra blobs.
function makeRom(code, extra = {}) {
  const rom = new Uint8Array(0x10000);
  rom[0x147] = 0x13; rom[0x149] = 0x03;
  rom.set([0xc3, 0x50, 0x01], 0x100); // JP 0x150
  rom.set(code, 0x150);
  for (const [addr, bytes] of Object.entries(extra)) rom.set(bytes, Number(addr));
  return rom;
}
// Run until PC reaches the "JR -2" spin at the end of the program.
function run(code, extra, setup) {
  const prog = [...code, 0x18, 0xfe];
  const gb = new GameBoy(makeRom(prog, extra));
  if (setup) setup(gb);
  const end = 0x150 + prog.length - 2;
  for (let i = 0; i < 200000 && gb.pc !== end; i++) gb.step();
  assert.strictEqual(gb.pc, end, 'program did not finish');
  return gb;
}

const tests = {
  'ADD sets Z H C': () => {
    const gb = run([0x3e, 0x3a, 0x06, 0xc6, 0x80]); // LD A,3A; LD B,C6; ADD A,B
    assert.strictEqual(gb.a, 0); assert.strictEqual(gb.f, 0xb0);
  },
  'DAA after ADD': () => {
    const gb = run([0x3e, 0x15, 0x06, 0x27, 0x80, 0x27]);
    assert.strictEqual(gb.a, 0x42); assert.strictEqual(gb.f & 0x10, 0);
  },
  'DAA after SUB': () => {
    const gb = run([0x3e, 0x42, 0xd6, 0x15, 0x27]);
    assert.strictEqual(gb.a, 0x27); assert.strictEqual(gb.f & 0x40, 0x40);
  },
  'SBC with carry': () => {
    const gb = run([0x37, 0x3e, 0x10, 0xde, 0x0f]); // SCF; LD A,10; SBC 0F -> 00
    assert.strictEqual(gb.a, 0x00); assert.strictEqual(gb.f, 0xe0);
  },
  'POP AF masks low nibble': () => {
    const gb = run([0x01, 0xff, 0x12, 0xc5, 0xf1]); // LD BC,12FF; PUSH BC; POP AF
    assert.strictEqual(gb.a, 0x12); assert.strictEqual(gb.f, 0xf0);
  },
  'CALL / RET': () => {
    // CALL 0x200 ; at 0x200: LD A,77 ; RET
    const gb = run([0xcd, 0x00, 0x02], { 0x200: [0x3e, 0x77, 0xc9] });
    assert.strictEqual(gb.a, 0x77); assert.strictEqual(gb.sp, 0xfffe);
  },
  'ADD SP,-1 flags': () => {
    const gb = run([0xe8, 0xff]);
    assert.strictEqual(gb.sp, 0xfffd); assert.strictEqual(gb.f, 0x30);
  },
  'LD HL,SP+2': () => {
    const gb = run([0x31, 0xff, 0xcf, 0xf8, 0x02]); // LD SP,CFFF; LD HL,SP+2
    assert.strictEqual(gb.hl, 0xd001); assert.strictEqual(gb.f, 0x30);
  },
  'ADD HL,DE half carry': () => {
    const gb = run([0x21, 0xff, 0x0f, 0x11, 0x01, 0x00, 0x19]);
    assert.strictEqual(gb.hl, 0x1000); assert.strictEqual(gb.f & 0x70, 0x20);
  },
  'CB SWAP / BIT / SRA / RES / SET': () => {
    const gb = run([0x3e, 0xf1, 0xcb, 0x37, 0x06, 0x81, 0xcb, 0x28, 0x0e, 0xff, 0xcb, 0x81, 0xcb, 0x7f]);
    assert.strictEqual(gb.a, 0x1f); assert.strictEqual(gb.b, 0xc0); assert.strictEqual(gb.c, 0xfe);
    assert.strictEqual(gb.f & 0x80, 0x80); // BIT 7,A of 0x1F -> Z
  },
  '(HL) read-modify-write': () => {
    const gb = run([0x21, 0x00, 0xc0, 0x36, 0x0f, 0x34, 0xcb, 0xc6, 0x7e]); // LD HL,C000; LD (HL),0F; INC (HL); SET 0,(HL); LD A,(HL)
    assert.strictEqual(gb.a, 0x11); assert.strictEqual(gb.f & 0x20, 0x20);
  },
  'timer interrupt wakes HALT': () => {
    // TMA=F0, TAC=05 (262144 Hz), IE=04, EI, HALT -> handler at 0x50: LD D,99; RETI
    const gb = run([0x3e, 0xf0, 0xe0, 0x06, 0xe0, 0x05, 0x3e, 0x05, 0xe0, 0x07, 0x3e, 0x04, 0xe0, 0xff, 0xfb, 0x76, 0x00],
      { 0x50: [0x16, 0x99, 0xd9] });
    assert.strictEqual(gb.d, 0x99);
  },
  'EI delay: interrupt after next instruction': () => {
    // IF=01 IE=01 then EI; INC B; INC B -> handler sets C=B
    const gb = run([0x3e, 0x01, 0xe0, 0xff, 0xe0, 0x0f, 0xfb, 0x04, 0x04], { 0x40: [0x48, 0xd9] });
    assert.strictEqual(gb.c, 1); assert.strictEqual(gb.b, 2);
  },
  'serial master with no cable reads 0xFF': () => {
    // LD A,42; LDH (01),A; LD A,81; LDH (02),A; wait: LDH A,(02); BIT 7,A; JR NZ wait; LDH A,(01)
    const gb = run([0x3e, 0x42, 0xe0, 0x01, 0x3e, 0x81, 0xe0, 0x02, 0xf0, 0x02, 0xcb, 0x7f, 0x20, 0xfa, 0xf0, 0x01]);
    assert.strictEqual(gb.a, 0xff); assert.strictEqual(gb.if_ & 0x08, 0x08);
  },
  'serial master waits for partner reply': () => {
    const gb = new GameBoy(makeRom([0x3e, 0x42, 0xe0, 0x01, 0x3e, 0x81, 0xe0, 0x02, 0xf0, 0x02, 0xcb, 0x7f, 0x20, 0xfa, 0xf0, 0x01, 0x18, 0xfe]));
    let sent = -1;
    gb.onSerialStart = (b) => { sent = b; };
    gb.run(20000);
    assert.strictEqual(sent, 0x42); assert.ok(gb.serialStall, 'should stall waiting for reply');
    gb.serialSupplyReply(0x5a);
    gb.run(20000);
    assert.strictEqual(gb.a, 0x5a);
  },
  'serial slave receives external byte': () => {
    const gb = run([0x3e, 0x24, 0xe0, 0x01, 0x3e, 0x80, 0xe0, 0x02]);
    assert.ok(gb.isSerialSlaveReady());
    assert.strictEqual(gb.serialReceive(0x99), 0x24);
    assert.strictEqual(gb.sb, 0x99); assert.ok(!gb.isSerialSlaveReady());
  },
  'MBC3 ROM banking + RAM': () => {
    const extra = { 0x8000: [0xab], 0xc000: [0xcd] };
    // LD A,02; LD (2000),A; LD A,(4000)->B ; LD A,03; LD (2000),A; LD A,(4000)->C ; RAM: enable, write, read
    const gb = run([0x3e, 0x02, 0xea, 0x00, 0x20, 0xfa, 0x00, 0x40, 0x47,
      0x3e, 0x03, 0xea, 0x00, 0x20, 0xfa, 0x00, 0x40, 0x4f,
      0x3e, 0x0a, 0xea, 0x00, 0x00, 0x3e, 0x5e, 0xea, 0x10, 0xa0, 0xaf, 0xfa, 0x10, 0xa0], extra);
    assert.strictEqual(gb.b, 0xab); assert.strictEqual(gb.c, 0xcd); assert.strictEqual(gb.a, 0x5e);
    assert.strictEqual(gb.getSave()[0x10], 0x5e);
  },
  'joypad matrix': () => {
    const gb = new GameBoy(makeRom([0x18, 0xfe]));
    gb.setKeys(0x01 | 0x40); // A + UP
    gb.wb(0xff00, 0x10); assert.strictEqual(gb.rb(0xff00) & 0x0f, 0x0e); // buttons: A low
    gb.wb(0xff00, 0x20); assert.strictEqual(gb.rb(0xff00) & 0x0f, 0x0b); // dpad: UP low
  },
  'VBlank every 70224 cycles': () => {
    const gb = new GameBoy(makeRom([0x18, 0xfe]));
    let frames = 0; gb.onFrame = () => frames++;
    gb.run(70224 * 10 + 10);
    assert.strictEqual(frames, 10);
  },
};

let fail = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ', name); } catch (e) { fail++; console.log('FAIL ', name, '-', e.message); }
}
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
