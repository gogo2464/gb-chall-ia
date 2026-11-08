'use strict';
// Runs the emulator in real time, kept in step with the link peer like BGB does.
//
// Rule: the console that RECEIVES link bytes (external clock) must never run ahead of the
// one that SENDS them. So while our game uses the port as the receiver, we stay behind the
// peer's latest clock, and BgbLink catches us up to each byte's timestamp before
// delivering it. While our game is the sender, we run on the wall clock and the peer
// follows us.
//
// follow: 'auto' (default, the rule above), true (always follow), false (never follow).
const { CPU_HZ, FRAME_CYCLES } = require('./gb');

function startPacer(gb, link, { speed = 1, intervalMs = 4, follow = 'auto', slackCycles = 0 } = {}) {
  const cyclesPerMs = (CPU_HZ / 1000) * speed;
  // Catch up at most ~4x real time, so a peer lying about its clock can't make us spin.
  const maxStep = FRAME_CYCLES * Math.max(1, speed);
  let last = performance.now();
  let budget = 0;

  const pump = () => {
    const now = performance.now();
    budget += (now - last) * cyclesPerMs;
    last = now;
    if (budget > maxStep) budget = maxStep;
    const following = follow === 'auto' ? gb.serialRole === 'slave' : follow;
    if (following) {
      const peer = link.cyclesUntilPeer(now, cyclesPerMs, slackCycles);
      if (peer !== null) budget = Math.min(maxStep, peer);
    }
    link.checkTimeout();
    if (budget > 0 && !gb.serialStall) budget -= gb.run(budget);
  };

  link.onActivity = () => setImmediate(pump);
  const timer = setInterval(pump, intervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { startPacer };
