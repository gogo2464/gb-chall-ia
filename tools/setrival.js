'use strict';
// Set the rival's name in a Pokemon Red/Blue (English) save and fix the checksum.
//   node tools/setrival.js --name "HerE-m_nam" [--in roms/pokered.sav] [--out roms/pokered.sav] [--underscore 7f]
// Names are at most 10 characters. Gen 1 has no "_": it is written as --underscore (hex byte,
// default 7f = space). Any character can also be given raw as \xNN.
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const RIVAL_OFFSET = 0x25f6;          // sMainData (0x25A3) + (wRivalName $D34A - wPokedexOwned $D2F7)
const CHECKSUM_START = 0x2598, CHECKSUM_END = 0x3522, CHECKSUM_AT = 0x3523;

const SPECIAL = { ' ': 0x7f, '(': 0x9a, ')': 0x9b, ':': 0x9c, ';': 0x9d, '[': 0x9e, ']': 0x9f,
  "'": 0xe0, '-': 0xe3, '?': 0xe6, '!': 0xe7, '.': 0xe8, '/': 0xf3, ',': 0xf4 };

function encode(name, underscore) {
  const out = [];
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '\\' && name[i + 1] === 'x') { out.push(parseInt(name.substr(i + 2, 2), 16)); i += 3; }
    else if (c >= 'A' && c <= 'Z') out.push(0x80 + c.charCodeAt(0) - 65);
    else if (c >= 'a' && c <= 'z') out.push(0xa0 + c.charCodeAt(0) - 97);
    else if (c >= '0' && c <= '9') out.push(0xf6 + c.charCodeAt(0) - 48);
    else if (c === '_') out.push(underscore);
    else if (SPECIAL[c] !== undefined) out.push(SPECIAL[c]);
    else throw new Error(`character "${c}" does not exist in Gen 1 (use \\xNN for a raw byte)`);
  }
  if (out.length > 10) throw new Error(`name is ${out.length} characters, the maximum is 10`);
  return out;
}

const name = opt('name');
if (!name) { console.error('usage: node tools/setrival.js --name NAME [--in f] [--out f] [--underscore 7f]'); process.exit(1); }
const input = opt('in', 'roms/pokered.sav');
const output = opt('out', input);
const sav = Buffer.from(fs.readFileSync(input));
const bytes = encode(name, parseInt(opt('underscore', '7f'), 16));

sav.fill(0x50, RIVAL_OFFSET, RIVAL_OFFSET + 11);        // 0x50 = end of string
Buffer.from(bytes).copy(sav, RIVAL_OFFSET);
let sum = 0;
for (let i = CHECKSUM_START; i <= CHECKSUM_END; i++) sum += sav[i];
sav[CHECKSUM_AT] = ~sum & 0xff;
fs.writeFileSync(output, sav);
console.log(`rival name set to "${name}" -> ${bytes.map((b) => b.toString(16)).join(' ')} 50, checksum ${sav[CHECKSUM_AT].toString(16)}, written ${output}`);
