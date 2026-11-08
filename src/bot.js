'use strict';
// Input bot for Pokemon Red/Blue (English). It keeps the player in the Cable Club and
// trades the first party Pokemon over and over.
//
// Expected starting save: the player stands in a Pokemon Center, in front of the
// Cable Club receptionist (right-hand counter), FACING her, and the game was saved there.
//
// Addresses come from the pret/pokered disassembly (pokered.sym).

const { KEY } = require('./gb');

const ADDR = {
  wPlayerFacing: 0xc109, // wSpritePlayerStateData1FacingDirection
  wTopMenuItemY: 0xcc24,
  wCurrentMenuItem: 0xcc26,
  wWhichTradeMonSelectionMenu: 0xcc49,
  wLinkState: 0xd12b,
  wPlayerName: 0xd158,
  wPartyCount: 0xd163,
  wPartySpecies: 0xd164,
  wPartyMons: 0xd16b,
  wPartyMonOT: 0xd273,
  wPartyMonNicks: 0xd2b5,
  wCurMap: 0xd35e,
  hSerialConnectionStatus: 0xffaa,
};

const MAP_TRADE_CENTER = 0xef;
const MAP_COLOSSEUM = 0xf0;
const LINK_STATE_IN_CABLE_CLUB = 0x01;
const LINK_STATE_TRADING = 0x32;
const USING_INTERNAL_CLOCK = 0x02;
const FACING_UP = 0x04, FACING_LEFT = 0x08, FACING_RIGHT = 0x0c;
const STATS_TRADE_MENU_Y = 16; // wTopMenuItemY of the "STATS / TRADE" box

// Gen 1 text encoding (subset).
function decodeText(gb, addr, max) {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = gb.rb(addr + i);
    if (c === 0x50) break;
    if (c >= 0x80 && c <= 0x99) s += String.fromCharCode(65 + c - 0x80);
    else if (c >= 0xa0 && c <= 0xb9) s += String.fromCharCode(97 + c - 0xa0);
    else if (c >= 0xf6) s += String.fromCharCode(48 + c - 0xf6);
    else if (c === 0x7f) s += ' ';
    else if (c === 0xe8) s += '.';
    else if (c === 0xe3) s += '-';
    else if (c === 0xe6) s += '?';
    else if (c === 0xe7) s += '!';
    else if (c === 0xf4) s += ',';
    else if (c === 0x9a) s += '(';
    else if (c === 0x9b) s += ')';
    else if (c === 0x9c) s += ':';
    else if (c === 0xba) s += 'é';
    else if (c === 0xbc) s += "'";
    else s += `\\x${c.toString(16).padStart(2, '0')}`;
  }
  return s;
}

function readParty(gb) {
  const n = Math.min(gb.rb(ADDR.wPartyCount), 6);
  const party = [];
  for (let i = 0; i < n; i++) {
    const mon = ADDR.wPartyMons + i * 44;
    party.push({
      species: gb.rb(ADDR.wPartySpecies + i),
      level: gb.rb(mon + 33),
      nick: decodeText(gb, ADDR.wPartyMonNicks + i * 11, 11),
      ot: decodeText(gb, ADDR.wPartyMonOT + i * 11, 11),
      otId: (gb.rb(mon + 12) << 8) | gb.rb(mon + 13),
    });
  }
  return party;
}

class TradeBot {
  constructor({ log = () => {}, holdFrames = 6, gapFrames = 6 } = {}) {
    this.log = log;
    this.hold = holdFrames;
    this.period = holdFrames + gapFrames;
    this.tick = 0;
    this.current = 0;
    this.toggle = false;
    this.lastMap = -1;
    this.lastLink = -1;
    this.lastParty = null;
    this.trades = 0;
  }

  choose(gb) {
    const map = gb.rb(ADDR.wCurMap);
    const link = gb.rb(ADDR.wLinkState);
    if (map === MAP_TRADE_CENTER && link === LINK_STATE_IN_CABLE_CLUB) {
      // Seated at the table: face the Game Boy on it, then A.
      // Internal-clock side sits on the left and must face right; the other faces left.
      const want = gb.rb(ADDR.hSerialConnectionStatus) === USING_INTERNAL_CLOCK ? FACING_RIGHT : FACING_LEFT;
      if (gb.rb(ADDR.wPlayerFacing) !== want) return want === FACING_RIGHT ? KEY.RIGHT : KEY.LEFT;
      return KEY.A;
    }
    if (map === MAP_TRADE_CENTER && link === LINK_STATE_TRADING) {
      const y = gb.rb(ADDR.wTopMenuItemY);
      if (y === STATS_TRADE_MENU_Y) {
        // "STATS / TRADE" box: cursor starts on STATS, so go RIGHT then A.
        this.toggle = !this.toggle;
        return this.toggle ? KEY.RIGHT : KEY.A;
      }
      if (gb.rb(ADDR.wWhichTradeMonSelectionMenu) === 1 && y !== 1) {
        // Cursor wandered onto the partner's party: go back left.
        this.toggle = !this.toggle;
        return this.toggle ? KEY.LEFT : KEY.A;
      }
    }
    // Loading a save makes the player face down: turn back toward the receptionist.
    // (map 0 = before the save is loaded; facing value 4 = up)
    if (map !== 0 && map !== MAP_TRADE_CENTER && map !== MAP_COLOSSEUM && link === 0 &&
        gb.rb(ADDR.wPlayerFacing) !== FACING_UP) return KEY.UP;
    // Everything else (title screen, receptionist dialog, YES to save,
    // TRADE CENTER menu, table in the trade room, trade confirm, evolution...) is A.
    return KEY.A;
  }

  onFrame(gb) {
    const phase = this.tick++ % this.period;
    if (phase === 0) this.current = this.choose(gb);
    gb.setKeys(phase < this.hold ? this.current : 0);
    if (this.tick % 30 === 0) this.observe(gb);
  }

  observe(gb) {
    const map = gb.rb(ADDR.wCurMap);
    const link = gb.rb(ADDR.wLinkState);
    if (map !== this.lastMap || link !== this.lastLink) {
      this.log('state', { map: hex(map), linkState: hex(link), where: describe(map, link) });
      this.lastMap = map; this.lastLink = link;
    }
    // Only trust party data while the game is actually running a save.
    if (gb.rb(ADDR.wPartyCount) > 6) return;
    const party = readParty(gb);
    const key = JSON.stringify(party);
    if (this.lastParty !== null && key !== this.lastParty && map === MAP_TRADE_CENTER) {
      this.trades++;
      this.log('party_changed', { trades: this.trades, party });
    } else if (this.lastParty === null && party.length) {
      this.log('party', { party });
    }
    this.lastParty = key;
  }
}

function hex(v) { return '0x' + v.toString(16).padStart(2, '0'); }
function describe(map, link) {
  if (map === MAP_TRADE_CENTER) return link === LINK_STATE_TRADING ? 'trade menu' : 'trade center room';
  if (map === MAP_COLOSSEUM) return 'colosseum';
  return link ? 'linking' : 'overworld/menus';
}

module.exports = { TradeBot, ADDR, readParty, decodeText };
