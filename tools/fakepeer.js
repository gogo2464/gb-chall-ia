'use strict';
// Minimal BGB-protocol client for poking at the server (protocol smoke test, not a game).
// It acts as a passive slave that always answers 0x00 and prints what the server sends.
//   node tools/fakepeer.js [host] [port] [seconds]
const net = require('net');
const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 8765);
const seconds = Number(process.argv[4] || 10);

const sock = net.connect(port, host, () => {
  console.log('connected');
  const send = (b1, b2 = 0, b3 = 0, b4 = 0, i1 = 0) => {
    if (!sock.writable) return;
    const p = Buffer.alloc(8); p[0] = b1; p[1] = b2; p[2] = b3; p[3] = b4; p.writeUInt32LE(i1 >>> 0, 4); sock.write(p);
  };
  send(1, 1, 4, 0, 0);
  send(108, 1);
  let buf = Buffer.alloc(0), count = 0;
  const seen = {};
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const p = buf.subarray(0, 8); buf = buf.subarray(8);
      seen[p[0]] = (seen[p[0]] || 0) + 1;
      if (p[0] === 104) { count++; if (count <= 20) console.log('server master byte', p[1].toString(16)); send(105, 0x00, 0x80); }
    }
  });
  setTimeout(() => { console.log('packets by command:', seen, 'master bytes:', count); sock.end(); }, seconds * 1000);
});
sock.on('error', (e) => { console.error(e.message); process.exit(1); });
