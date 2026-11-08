# GB Trade Server (CTF)

A headless Game Boy emulator server. Each TCP connection gets its own fresh Pokemon Red
emulator that walks into the Cable Club **Trade Center** and keeps trading its first party
Pokemon with whoever is on the other end of the (virtual) link cable.

Players connect with the **BGB** emulator (Link → Connect → `host:8765`) or with their own
script speaking the [BGB link protocol](https://bgb.bircd.org/bgblink.html), which is what
you want if the challenge is about sending crafted trade data.

No dependencies: Node.js ≥ 18 only.

## Layout

| File | What it does |
|---|---|
| `src/gb.js` | Game Boy core: SM83 CPU, MBC1/3/5, timer, PPU timing (+ optional rendering), joypad, serial port |
| `src/bot.js` | Reads Pokemon Red RAM and presses buttons: receptionist → save → TRADE CENTER → table → trade slot 1 → confirm, forever |
| `src/bgblink.js` | BGB link protocol (server can be master or slave) |
| `src/session.js` | One child process per connection: boots the game at full speed, then runs in real time |
| `src/server.js` | TCP listener, session limits (total / per IP), timeouts |
| `tools/run.js` | Run the ROM headless and dump PNG screenshots |
| `tools/linktest.js` | Two emulators linked together offline: full end-to-end trade test |
| `tools/bgbtest.js` | A bot-driven emulator that connects to the server over TCP like a player would |
| `tools/script.js` | Replay a button script on a save and export the result (used to build the Cable Club save) |
| `tools/fakepeer.js` | Tiny BGB client for protocol smoke tests |
| `tests/cpu.test.js` | CPU / hardware self-tests (no ROM needed) |

## 1. Prepare the ROM and save

Put these in `roms/` (they are not shipped):

- `pokered.gb`: Pokemon Red/Blue, English.
- `pokered.sav`: 32 KiB battery save. Make it in BGB (or any emulator): go to any Pokemon
  Center, stand in front of the **Cable Club receptionist** (right-hand counter), **face
  her**, and save the game. Put the Pokemon the server should hand out (the flag carrier,
  e.g. a nicknamed mon) in **party slot 1**.

The bundled `roms/pokered.sav` was rebuilt this way from the original (kept as
`roms/pokered.original.sav`): flew to Viridian City, stood at the Cable Club receptionist
(x=11, y=3, facing up) and saved in-game. To rebuild it from another save, see
`tools/script.js`.

Check that it boots where you expect:

```bash
node tools/run.js --seconds 30 --out shots
```

Open `shots/*.png`. After ~20 s you should see the player in front of the receptionist,
with "Please come again!" style dialogs (no partner is connected in this mode).

## 2. Test the whole trade loop offline

```bash
node tools/linktest.js --seconds 300
```

Over the real network path:

```bash
SPEED=10 node src/server.js
```

```bash
node tools/bgbtest.js --speed 10 --seconds 60
```

`linktest.js` links two copies of the server bot to each other. Both should reach the Trade Center
and log `party_changed` events. Screenshots go to `shots-linktest/`. Exit code 0 means
both sides traded.

## 3. Run

```bash
npm test
```

```bash
node src/server.js
```

Or with Docker:

```bash
docker compose up -d --build
```

Logs are JSON lines on stdout (`connect`, `state`, `party_changed` with full party
contents after every trade, `session_end`).

### Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `8765` | BGB's default link port |
| `ROM_PATH` / `SAVE_PATH` | `roms/pokered.gb` / `roms/pokered.sav` | |
| `MAX_SESSIONS` | `16` | Concurrent emulators |
| `MAX_PER_IP` | `2` | |
| `SESSION_TIMEOUT` | `900` | Seconds before a session is closed |
| `BOOT_FRAMES` | `1200` | Frames run at full speed before link traffic is handled (title → CONTINUE → overworld) |
| `SPEED` | `1` | Emulation speed multiplier |
| `LINK_REPLY_TIMEOUT_MS` | `3000` | If the player never answers a byte, it reads as `0xFF` |
| `SCREENSHOT_DIR` | *(off)* | Debug: write `session-<id>.png` every `SCREENSHOT_EVERY` seconds |
| `TRACE_BYTES` | `0` | Debug: log every link byte |

## How players trade

1. Connect BGB to `host:8765` (Link → Connect), load Pokemon Red/Blue, go to a Pokemon
   Center and talk to the Cable Club receptionist. The server is already talking to its own
   receptionist on a loop, so the link is established within a few seconds.
2. Choose **TRADE CENTER**, sit at the table, press A.
3. Pick a Pokemon. The server always offers its slot 1 and accepts any trade.

Each connection is a brand-new game from the same save, so trades never carry over between
players.

## Notes

- RAM addresses are from the pret/pokered disassembly (English Red/Blue). Other versions
  (Yellow, Japanese, other languages) need different addresses in `src/bot.js`.
- Each session is a separate process with a 96 MB heap cap. The Compose file runs the
  container read-only, with no capabilities and limits on PIDs, memory and CPU.
- With network lag, each link byte costs one round trip, so a full trade takes longer over
  the internet than on a real cable. That is expected; the game's own timeouts handle it.
- Link timing follows BGB: the server sends its clock every 8 ms, and before answering a
  byte it runs up to the time the sender stamped on it. Both consoles stay in step like on a
  real cable. Without that, one side can miss the final menu byte and the player gets
  "The link has been closed because of inactivity".
- Every `session_end` log line has link counters. `acksSent` = bytes from the player that
  arrived while the server game was not listening (a few is normal). `replyTimeouts` = the
  player never answered for `LINK_REPLY_TIMEOUT_MS` (should be 0). `resyncs` = the clocks
  drifted over 4 s apart and were re-aligned (the player paused BGB, or a slow machine).
  For a full byte trace, run with `TRACE_BYTES=1`.
- The emulator is accurate to the instruction, not the cycle. That is plenty for Pokemon. If
  you want to validate the CPU further, run blargg's `cpu_instrs.gb` with
  `node tools/run.js --rom cpu_instrs.gb --no-bot --serial --seconds 60`.
