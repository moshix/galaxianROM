/**
 * Attack selection and difficulty: who leaves the formation, from which side,
 * how often, and how much the game has been turning the screws.
 *
 * Three independent clocks feed this. A chain of counters decides when *an*
 * alien may attack (CHECK_IF_ALIEN_CAN_ATTACK), a second chain decides when a
 * flagship may (UPDATE_ATTACK_COUNTERS / CHECK_IF_FLAGSHIP_CAN_ATTACK), and a
 * slow ramp raises DIFFICULTY_EXTRA_VALUE every 20 seconds of live play
 * (HANDLE_LEVEL_DIFFICULTY). The two "can attack" flags they raise are consumed
 * the following frame by HANDLE_SINGLE_ALIEN_ATTACK and HANDLE_FLAGSHIP_ATTACK,
 * which pick the actual alien and hand it to the state machine in
 * src/game/inflight.js.
 *
 * Geometry reminder, because every scan direction in here depends on it: the
 * swarm array is index = row*16 + column, and COLUMN 3 IS THE RIGHTMOST ON
 * SCREEN. @see reference/galaxian.asm:327-356, 424-434
 */

import { VAR, BLOCK, PORT, INFLIGHT_ALIEN, INFLIGHT_SLOT } from '../machine/addresses.js';
import { inflight, setInflight } from '../machine/machine.js';
import { generateRandomNumber } from './rng.js';
import { ALIEN_ATTACK_COUNTER_DEFAULTS } from './tables.js';
import { COMMAND, queueCommand } from './inflight.js';

/** $41EF, the flagship row's entry in HAVE_ALIENS_IN_ROW_FLAGS. */
const HAVE_ALIENS_IN_TOP_ROW = BLOCK.HAVE_ALIENS_IN_ROW_FLAGS.addr + 7;

/** Both flank routines force the flank when within this many pixels of a wall. */
export const FLANK_FORCE_MARGIN = 0x1c;

/** Maximum DIFFICULTY_BASE_VALUE and DIFFICULTY_EXTRA_VALUE. */
export const DIFFICULTY_MAX = 7;

/**
 * Rotate a byte left, which is what `rlca` does. The distinction from a shift
 * matters in UPDATE_ATTACK_COUNTERS, where the value is doubled three times.
 * @param {number} value
 * @returns {number}
 */
function rotateLeft8(value) {
  const v = value & 0xff;
  return ((v << 1) | (v >> 7)) & 0xff;
}

/**
 * Read an ALIEN_SWARM_FLAGS cell by its 8-bit index, the way the ROM does with
 * `ld h,$41 / ld l,index`.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index
 * @returns {number}
 */
function swarmFlag(m, index) {
  return m.peek(BLOCK.ALIEN_SWARM_FLAGS.addr + (index & 0xff));
}

/**
 * True when an INFLIGHT_ALIEN record is free, i.e. neither flying nor dying.
 * The original ORs the two whole bytes rather than testing bit 0.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @returns {boolean}
 */
function isSlotFree(m, slot) {
  return ((inflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE)
    | inflight(m, slot, INFLIGHT_ALIEN.IS_DYING)) & 0xff) === 0;
}

// -- launching an alien -----------------------------------------------------

/**
 * WAKEUP_INFLIGHT_ALIEN ($13CE). Lift one alien out of the formation into a
 * prepared record and erase its characters.
 * @see reference/galaxian.asm:4911-4918
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {number} index swarm cell index, row*16 + column
 */
export function wakeupInflightAlien(m, slot, index) {
  m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + index, 0);
  setInflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM, index);
  setInflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE, 1);
  setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0);
  queueCommand(m, COMMAND.DELETE_ALIEN, index);
}

/**
 * INIT_INFLIGHT_ALIEN ($145C). As above, but also stamps the peel direction --
 * this is the entry point the flagship path uses.
 * @see reference/galaxian.asm:5058-5066
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {number} index
 * @param {number} arcClockwise the C register: 0 left flank, 1 right flank
 */
export function initInflightAlien(m, slot, index, arcClockwise) {
  m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + index, 0);
  setInflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE, 1);
  setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0);
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE, arcClockwise);
  setInflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM, index);
  queueCommand(m, COMMAND.DELETE_ALIEN, index);
}

/**
 * TRY_INIT_INFLIGHT_ALIEN ($1446). Find a free record among the four lone-
 * attacker slots, scanning from the last backwards, and launch into it.
 * @see reference/galaxian.asm:5039-5047
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index swarm cell to launch
 * @param {number} arcClockwise
 */
export function tryInitInflightAlien(m, index, arcClockwise) {
  for (let slot = INFLIGHT_SLOT.LAST_ATTACKER; slot >= INFLIGHT_SLOT.FIRST_ATTACKER; slot -= 1) {
    if (isSlotFree(m, slot)) {
      initInflightAlien(m, slot, index, arcClockwise);
      return;
    }
  }
}

/**
 * TRY_INIT_ESCORT_INFLIGHT_ALIEN ($149B). Launch a red alien as a flagship
 * escort, copying the flagship's peel direction so the three break away in
 * formation.
 * @see reference/galaxian.asm:5116-5136
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} escortSlot
 * @param {number} index
 */
export function tryInitEscortInflightAlien(m, escortSlot, index) {
  if (inflight(m, escortSlot, INFLIGHT_ALIEN.IS_ACTIVE) & 1) return;
  if (inflight(m, escortSlot, INFLIGHT_ALIEN.IS_DYING) & 1) return;

  m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + index, 0);
  setInflight(m, escortSlot, INFLIGHT_ALIEN.IS_ACTIVE, 1);
  setInflight(m, escortSlot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0);
  setInflight(m, escortSlot, INFLIGHT_ALIEN.ARC_CLOCKWISE,
    inflight(m, INFLIGHT_SLOT.FLAGSHIP, INFLIGHT_ALIEN.ARC_CLOCKWISE));
  setInflight(m, escortSlot, INFLIGHT_ALIEN.INDEX_IN_SWARM, index);
  queueCommand(m, COMMAND.DELETE_ALIEN, index);
}

/**
 * INIT_FLAGSHIP_ATTACK_FROM_LEFT_FLANK ($1472) and its right-flank twin
 * ($14D7).
 *
 * The flagship always takes slot 1. It then looks at the three red aliens
 * immediately below it, starting from the flank side, and recruits at most two
 * of them into slots 2 and 3. `delta` steps one row down and one column towards
 * the flank; `step` walks along that row away from it.
 *
 * @see reference/galaxian.asm:5078-5100, 5162-5175
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index the flagship's swarm cell
 * @param {number} arcClockwise
 * @param {number} delta -$0F on the left flank, -$11 on the right
 * @param {number} step -1 on the left flank, +1 on the right
 */
function initFlagshipAttack(m, index, arcClockwise, delta, step) {
  initInflightAlien(m, INFLIGHT_SLOT.FLAGSHIP, index, arcClockwise);

  let cell = (index + delta) & 0xff;
  let escortSlot = INFLIGHT_SLOT.ESCORT_A;
  let cellsLeft = 3;
  let escortsWanted = 2;

  do {
    if (swarmFlag(m, cell) & 1) {
      tryInitEscortInflightAlien(m, escortSlot, cell);
      // $1491: IY advances whether or not the escort slot was actually free.
      escortSlot += 1;
      escortsWanted -= 1;
      // $1498: two escorts is the limit, so arrange for the djnz to fall out.
      if (escortsWanted === 0) cellsLeft = 1;
    }
    cell = (cell + step) & 0xff;
    cellsLeft -= 1;
  } while (cellsLeft !== 0);
}

// -- who attacks ------------------------------------------------------------

/**
 * SET_ALIEN_ATTACK_FLANK ($13E1).
 *
 * Within 28 pixels of a scroll extent the flank is forced to the far side from
 * the wall, because peeling off needs 32 pixels of sideways room and
 * ArcClockwise is set straight from this flag. Anywhere else it is a coin flip.
 *
 * @see reference/galaxian.asm:4929-4955
 * @param {import('../machine/machine.js').Machine} m
 */
export function setAlienAttackFlank(m) {
  const scroll = m.peek16(VAR.SWARM_SCROLL_VALUE);
  const leftLimit = m.peek(VAR.SWARM_SCROLL_MAX_EXTENTS);
  const rightLimit = m.peek(VAR.SWARM_SCROLL_MAX_EXTENTS + 1);
  const low = scroll & 0xff;

  if (scroll & 0x8000) {
    // Displaced right; attack from the left if we are close to the right wall.
    if (((low - rightLimit) & 0xff) < FLANK_FORCE_MARGIN) {
      m.poke(VAR.ALIENS_ATTACK_FROM_RIGHT_FLANK, 0);
      return;
    }
  } else if (((leftLimit - low) & 0xff) < FLANK_FORCE_MARGIN) {
    m.poke(VAR.ALIENS_ATTACK_FROM_RIGHT_FLANK, 1);
    return;
  }
  m.poke(VAR.ALIENS_ATTACK_FROM_RIGHT_FLANK, generateRandomNumber(m) & 1);
}

/**
 * The `cpdr`/`cpir` column search at $137B and $13AB.
 *
 * Finds the outermost occupied column on the given flank. The repeat forms set
 * P/V from the counter, and the `ret po` at $1386/$13B6 discards a match found
 * on the very last cell scanned -- so the tenth column in each direction can
 * never be chosen, a quirk of the original that the ROM oracle confirms.
 *
 * @see reference/galaxian.asm:4801-4807, 4847-4853
 * @param {import('../machine/machine.js').Machine} m
 * @param {boolean} fromRight
 * @returns {{index: number, columnsLeft: number}|null} null if nothing usable
 */
function findOutermostOccupiedColumn(m, fromRight) {
  const flags = BLOCK.ALIEN_IN_COLUMN_FLAGS.addr;
  let low = fromRight ? 0xf3 : 0xfc;
  let columnsLeft = 10;
  let matched = false;

  for (;;) {
    matched = m.peek((flags & 0xff00) | low) === 1;
    low = (low + (fromRight ? 1 : -1)) & 0xff;
    columnsLeft -= 1;
    if (matched || columnsLeft === 0) break;
  }
  if (!matched) return null; // $1385/$13B5 ret nz
  if (columnsLeft === 0) return null; // $1386/$13B6 ret po

  // The repeat form has stepped one past the match; undo that.
  return { index: (low + (fromRight ? -1 : 1)) & 0xff, columnsLeft };
}

/**
 * HANDLE_SINGLE_ALIEN_ATTACK ($1344).
 *
 * Sends one alien, if the pacing counters have said it may and a record is
 * free. The number of records it will consider grows with difficulty, which is
 * what caps how many lone attackers can be on screen: `min(4, (base+extra)/2+1)`.
 *
 * The alien chosen is the topmost one in the outermost occupied column on the
 * chosen flank -- and while any flagship is still alive the search starts at
 * the purple row, so red aliens stay in reserve as flagship escorts.
 *
 * @see reference/galaxian.asm:4773-4901
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSingleAlienAttack(m) {
  if ((m.peek(VAR.CAN_ALIEN_ATTACK) & 1) === 0) return;
  m.poke(VAR.CAN_ALIEN_ATTACK, 0);
  if (m.peek(VAR.HAVE_NO_ALIENS_IN_SWARM) & 1) return;

  // $1352-$135E. The `rra` rotates in the carry from `add a,l`, so a sum over
  // 255 would come back with bit 7 set; that cannot happen while both values
  // are clamped to 7, but it is reproduced rather than written as a shift.
  const sum = m.peek(VAR.DIFFICULTY_BASE_VALUE) + m.peek(VAR.DIFFICULTY_EXTRA_VALUE);
  let slotsToScan = (((sum & 0x100) >> 1) | ((sum & 0xff) >> 1)) & 0xff;
  if (slotsToScan >= 4) slotsToScan = 3;
  slotsToScan += 1;

  let slot = -1;
  for (let i = 0; i < slotsToScan; i += 1) {
    const candidate = INFLIGHT_SLOT.LAST_ATTACKER - i;
    if (isSlotFree(m, candidate)) { slot = candidate; break; }
  }
  if (slot < 0) return;

  const fromRight = m.peek(VAR.ALIENS_ATTACK_FROM_RIGHT_FLANK);
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE, fromRight);

  const column = findOutermostOccupiedColumn(m, fromRight !== 0);
  if (column === null) return;

  // $138A. With flagships alive only purple and blue may be sent; without them
  // the red row joins in and the fallback stride grows by one row.
  const haveFlagships = (m.peek(HAVE_ALIENS_IN_TOP_ROW) & 1) !== 0;
  const rowsToScan = haveFlagships ? 4 : 5;
  const topRowBase = haveFlagships ? 0x50 : 0x60;
  const fallbackStride = ((fromRight !== 0 ? 0x41 : 0x3f) + (haveFlagships ? 0 : 0x10)) & 0xff;

  let cell = ((column.index & 0x0f) + topRowBase) & 0xff;
  let columnsLeft = column.columnsLeft;

  // SCAN_SPECIFIC_COLUMN_FOR_D_ROWS ($139A): walk down the column and take the
  // first alien found.
  for (;;) {
    for (let row = 0; row < rowsToScan; row += 1) {
      if (swarmFlag(m, cell) & 1) { wakeupInflightAlien(m, slot, cell); return; }
      cell = (cell - 0x10) & 0xff;
    }
    // $13A5: the column flag lied. Step to the next column inward and retry.
    // Never observed in play, but it is real code and it is reproduced.
    cell = (cell + fallbackStride) & 0xff;
    columnsLeft = (columnsLeft - 1) & 0xff;
    if (columnsLeft === 0) return;
  }
}

/**
 * HANDLE_FLAGSHIP_ATTACK ($140C).
 *
 * Looks for a flagship on the chosen flank and, if it finds one, sends it with
 * up to two red escorts. With no flagship available it falls back to sending a
 * single red alien from the same flank.
 *
 * @see reference/galaxian.asm:4985-5037, 5139-5156
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleFlagshipAttack(m) {
  if (m.peek(VAR.HAVE_NO_ALIENS_IN_SWARM) & 1) return;
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  if ((m.peek(VAR.CAN_FLAGSHIP_OR_RED_ALIENS_ATTACK) & 1) === 0) return;
  m.poke(VAR.CAN_FLAGSHIP_OR_RED_ALIENS_ATTACK, 0);

  // $141F: the flagship's own record must be free.
  if ((inflight(m, INFLIGHT_SLOT.FLAGSHIP, INFLIGHT_ALIEN.IS_ACTIVE)
    | inflight(m, INFLIGHT_SLOT.FLAGSHIP, INFLIGHT_ALIEN.IS_DYING)) & 1) return;

  const arcClockwise = m.peek(VAR.ALIENS_ATTACK_FROM_RIGHT_FLANK);
  const fromRight = (arcClockwise & 1) !== 0;

  // Flagship row $4176-$4179 is columns 6-9; the red row below spans $4165-$416A.
  const flagshipStart = fromRight ? 0x76 : 0x79;
  const redStart = fromRight ? 0x65 : 0x6a;
  const step = fromRight ? 1 : -1;

  let cell = flagshipStart;
  for (let i = 0; i < 4; i += 1, cell = (cell + step) & 0xff) {
    if (swarmFlag(m, cell) & 1) {
      initFlagshipAttack(m, cell, arcClockwise, fromRight ? -0x11 : -0x0f, step);
      return;
    }
  }

  cell = redStart;
  for (let i = 0; i < 4; i += 1, cell = (cell + step) & 0xff) {
    if (swarmFlag(m, cell) & 1) { tryInitInflightAlien(m, cell, arcClockwise); return; }
  }
}

// -- pacing and difficulty --------------------------------------------------

/**
 * HANDLE_LEVEL_DIFFICULTY ($14F3).
 *
 * A two-stage divider: 60 frames, then 20 of those, then DIFFICULTY_EXTRA_VALUE
 * goes up by one. That is +1 every 1200 frames, about 20 seconds, capped at 7.
 * The ramp is frozen while the swarm is in shock from a flagship kill.
 *
 * @see reference/galaxian.asm:5183-5214
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleLevelDifficulty(m) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  if (m.peek(VAR.IS_FLAGSHIP_HIT) & 1) return;

  const first = (m.peek(VAR.DIFFICULTY_COUNTER_1) - 1) & 0xff;
  m.poke(VAR.DIFFICULTY_COUNTER_1, first);
  if (first !== 0) return;
  m.poke(VAR.DIFFICULTY_COUNTER_1, 0x3c);

  const second = (m.peek(VAR.DIFFICULTY_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.DIFFICULTY_COUNTER_2, second);
  if (second !== 0) return;
  m.poke(VAR.DIFFICULTY_COUNTER_2, 0x14);

  const extra = m.peek(VAR.DIFFICULTY_EXTRA_VALUE);
  if (extra === DIFFICULTY_MAX) return;
  // $150E: an unsigned `jr nc` on an out-of-range value clamps rather than wraps.
  if (extra > DIFFICULTY_MAX) { m.poke(VAR.DIFFICULTY_EXTRA_VALUE, DIFFICULTY_MAX); return; }
  m.poke(VAR.DIFFICULTY_EXTRA_VALUE, (extra + 1) & 0xff);
}

/**
 * CHECK_IF_ALIEN_CAN_ATTACK ($1515).
 *
 * A master counter ticks down to zero every five frames, and on each of those
 * frames the first B of fifteen secondary counters are decremented, where B
 * grows with difficulty. Any secondary reaching zero reloads from its default
 * and raises CAN_ALIEN_ATTACK. Because the defaults are mostly odd and mutually
 * prime, the combined pattern of launches never settles into a rhythm.
 *
 * @see reference/galaxian.asm:5222-5275, 5411-5421
 * @param {import('../machine/machine.js').Machine} m
 */
export function checkIfAlienCanAttack(m) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  if (m.peek(VAR.HAVE_NO_ALIENS_IN_SWARM) & 1) return;
  if (m.peek(VAR.IS_FLAGSHIP_HIT) & 1) return;

  // $1527-$1531: the base value only contributes once it reaches 2.
  const base = m.peek(VAR.DIFFICULTY_BASE_VALUE);
  const extra = m.peek(VAR.DIFFICULTY_EXTRA_VALUE);
  const countersToTick = ((((base >= 2 ? base : 0) + extra) & 0x0f) + 1) & 0xff;

  const counters = BLOCK.ALIEN_ATTACK_COUNTERS.addr;
  const master = (m.peek(counters) - 1) & 0xff;
  m.poke(counters, master);
  if (master !== 0) { m.poke(VAR.CAN_ALIEN_ATTACK, 0); return; }
  m.poke(counters, ALIEN_ATTACK_COUNTER_DEFAULTS[0]);

  let fired = 0;
  for (let i = 1; i <= countersToTick; i += 1) {
    const reload = ALIEN_ATTACK_COUNTER_DEFAULTS[i];
    // countersToTick maxes out at 15 while both difficulty values are clamped
    // to 7, so the table is never overrun in play.
    if (reload === undefined) throw new RangeError(`no default for attack counter ${i}`);
    const value = (m.peek(counters + i) - 1) & 0xff;
    m.poke(counters + i, value);
    if (value === 0) { m.poke(counters + i, reload); fired = (fired + 1) & 0xff; }
  }
  if (fired === 0) return;
  m.poke(VAR.CAN_ALIEN_ATTACK, 1);
}

/**
 * The $15A7 branch of UPDATE_ATTACK_COUNTERS: fixed pacing for attract mode,
 * where there is no difficulty to read.
 * @see reference/galaxian.asm:5353-5379
 * @param {import('../machine/machine.js').Machine} m
 */
function updateAttractModeAttackCounters(m) {
  const first = (m.peek(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1) - 1) & 0xff;
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1, first);
  if (first !== 0) return;
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1, 0x3c);

  const second = (m.peek(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, second);
  if (second !== 0) return;
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, 0x05);

  m.poke(VAR.FLAGSHIP_ATTACK_SECONDARY_COUNTER, 0x5a);
  m.poke(BLOCK.ALIEN_ATTACK_COUNTERS.addr, 0x2d);
  m.poke(VAR.ENABLE_FLAGSHIP_ATTACK_SECONDARY_COUNTER, 1);
}

/**
 * UPDATE_ATTACK_COUNTERS ($1555): schedule the next flagship sortie.
 *
 * Once a second, and then once every 6-9 of those seconds -- fewer the higher
 * the difficulty and the more flagships were carried over from the last wave --
 * it arms the countdown that CHECK_IF_FLAGSHIP_CAN_ATTACK watches, and resets
 * the lone-alien master counter to twice that so the two do not collide. With
 * the blue and purple rows gone it skips the second divider entirely and uses a
 * flat value of 2.
 *
 * @see reference/galaxian.asm:5284-5350
 * @param {import('../machine/machine.js').Machine} m
 */
export function updateAttackCounters(m) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  if ((m.peek(HAVE_ALIENS_IN_TOP_ROW) & 1) === 0) return;
  if (m.peek(VAR.IS_FLAGSHIP_HIT) & 1) return;
  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) { updateAttractModeAttackCounters(m); return; }

  const first = (m.peek(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1) - 1) & 0xff;
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1, first);
  if (first !== 0) return;
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1, 0x3c);

  let interval;
  if (m.peek(VAR.HAVE_NO_BLUE_OR_PURPLE_ALIENS) & 1) {
    interval = 0x02; // $15A3, and note it does NOT rewrite counter 2
  } else {
    const second = (m.peek(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2) - 1) & 0xff;
    m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, second);
    if (second !== 0) return;
    m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, 1); // $157A inc (hl), from 0

    // $157B: $4177 and $4178 are the two cells a carried-over flagship is
    // re-inserted into, so their sum is the number of extras this wave.
    const flags = BLOCK.ALIEN_SWARM_FLAGS.addr;
    const extraFlagships = (m.peek(flags + 0x77) + m.peek(flags + 0x78)) & 3;

    const difficulty = (m.peek(VAR.DIFFICULTY_BASE_VALUE)
      + m.peek(VAR.DIFFICULTY_EXTRA_VALUE)) & 0xff;
    if (difficulty === 0) return; // $1588 ret z

    // $1589-$1590: two `rrca`s then `and $03` keep bits 2-3, and `cpl / add $0A`
    // turns 0..3 into 9..6 -- higher difficulty, shorter wait.
    const quarter = (difficulty >> 2) & 0x03;
    interval = ((((~quarter) & 0xff) + 0x0a) - extraFlagships) & 0xff;
    m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, interval);
  }

  // $1594-$159A: two rotates, then a third, so x4 and x8.
  const secondary = rotateLeft8(rotateLeft8(interval));
  m.poke(VAR.FLAGSHIP_ATTACK_SECONDARY_COUNTER, secondary);
  m.poke(BLOCK.ALIEN_ATTACK_COUNTERS.addr, rotateLeft8(secondary));
  m.poke(VAR.ENABLE_FLAGSHIP_ATTACK_SECONDARY_COUNTER, 1);
}

/**
 * CHECK_IF_FLAGSHIP_CAN_ATTACK ($15C3). Runs down the armed countdown and, when
 * it expires, raises the flag HANDLE_FLAGSHIP_ATTACK consumes.
 * @see reference/galaxian.asm:5381-5405
 * @param {import('../machine/machine.js').Machine} m
 */
export function checkIfFlagshipCanAttack(m) {
  if ((m.peek(VAR.ENABLE_FLAGSHIP_ATTACK_SECONDARY_COUNTER) & 1) === 0) return;

  const remaining = (m.peek(VAR.FLAGSHIP_ATTACK_SECONDARY_COUNTER) - 1) & 0xff;
  m.poke(VAR.FLAGSHIP_ATTACK_SECONDARY_COUNTER, remaining);
  if (remaining !== 0) return;

  m.poke(VAR.ENABLE_FLAGSHIP_ATTACK_SECONDARY_COUNTER, 0);
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  if ((m.peek(HAVE_ALIENS_IN_TOP_ROW) & 1) === 0) return;
  m.poke(VAR.CAN_FLAGSHIP_OR_RED_ALIENS_ATTACK, 1);
}

/**
 * HANDLE_CALC_INFLIGHT_ALIEN_SHOOTING_DISTANCE ($15F4).
 *
 * Sets how far up the screen a diving alien may open fire: an exact X, plus a
 * count of 25-pixel steps above it that also qualify. The count grows by one
 * for every empty *pair* of row flags scanned from $41E8.
 *
 * Note that the scan starts on $41E8/$41E9, which are cleared every frame and
 * never hold anything, so the first pair is always empty: the multiplier is
 * therefore 3 with a full swarm, not the 2 it is loaded with.
 *
 * @see reference/galaxian.asm:5431-5458
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleCalcInflightAlienShootingDistance(m) {
  // $15F9: DIFFICULTY_BASE_VALUE is 2 or more in play, so the $84/1 pair is
  // dead code for an easier setting that never shipped.
  const easy = m.peek(VAR.DIFFICULTY_BASE_VALUE) === 0;
  let multiplier = easy ? 1 : 2;
  const exactX = easy ? 0x84 : 0x9d;

  let addr = BLOCK.HAVE_ALIENS_IN_ROW_FLAGS.addr;
  for (let pair = 0; pair < 4; pair += 1) {
    if (m.peek(addr) & 1) break;
    addr += 1;
    if (m.peek(addr) & 1) break;
    addr += 1;
    multiplier = (multiplier + 1) & 0xff;
  }

  // $1610 `ld ($4213),de` writes E to $4213 and D to $4214.
  m.poke(VAR.INFLIGHT_ALIEN_SHOOT_RANGE_MUL, multiplier);
  m.poke(VAR.INFLIGHT_ALIEN_SHOOT_EXACT_X, exactX);
}

/**
 * CLAMP_DIFFICULTY_LEVEL ($1683).
 *
 * The tail HANDLE_LEVEL_COMPLETE jumps to when DIFFICULTY_BASE_VALUE has
 * somehow gone above its maximum. It shares $1662 with the normal path, which
 * writes the base value and the player level back as a pair, so the level has
 * to be supplied by the caller that already incremented it.
 *
 * @see reference/galaxian.asm:5517-5521, 5542-5544
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} playerLevel the H half of the pair at $421B
 */
export function clampDifficultyLevel(m, playerLevel) {
  m.poke16(VAR.DIFFICULTY_BASE_VALUE, ((playerLevel & 0xff) << 8) | DIFFICULTY_MAX);
}

/**
 * HANDLE_SHOCKED_SWARM ($1688).
 *
 * Shooting a flagship stuns the formation for 240 frames: no new sorties, no
 * shooting, no difficulty ramp. The counter only runs down once the swarm has
 * something else to do -- when the aliens are already enraged, when the blue
 * and purple rows are gone, or when nothing is currently in flight -- so an
 * aggressive wave shakes the shock off while a fresh one sits stunned.
 *
 * @see reference/galaxian.asm:5550-5568
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleShockedSwarm(m) {
  if ((m.peek(VAR.IS_FLAGSHIP_HIT) & 1) === 0) return;

  const mayRecover = m.peek(VAR.HAVE_AGGRESSIVE_ALIENS) !== 0
    || m.peek(VAR.HAVE_NO_BLUE_OR_PURPLE_ALIENS) !== 0
    || (m.peek(VAR.HAVE_NO_INFLIGHT_ALIENS) & 1) !== 0;
  if (!mayRecover) return;

  const remaining = (m.peek(VAR.ALIENS_IN_SHOCK_COUNTER) - 1) & 0xff;
  m.poke(VAR.ALIENS_IN_SHOCK_COUNTER, remaining);
  if (remaining !== 0) return;
  m.poke(VAR.IS_FLAGSHIP_HIT, 0);
}

/**
 * HANDLE_ALIEN_AGGRESSIVENESS ($16B8).
 *
 * One loop, two jobs, and they must stay in the one loop or the audio and the
 * aggression flag will disagree. It counts the survivors, enables one
 * background oscillator per survivor up to three -- which is why the swarm hum
 * thins from three tones to silence as you clear the formation -- and sets
 * HAVE_AGGRESSIVE_ALIENS when three or fewer are left.
 *
 * The threshold falls out of the `dec a` at $16D6 being the head of the djnz
 * loop rather than a one-off: three passes leave A = survivors - 2 at the
 * `cp $02`, so the flag is set when survivors <= 3.
 *
 * @see reference/galaxian.asm:5615-5658
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleAlienAggressiveness(m) {
  if (m.peek(VAR.IS_GAME_OVER) & 1) return;

  // $16C4 seeds the total with 1, so A is survivors + 1 when the count ends.
  let total = 1;
  let index = 0x23; // $4123: row 2, column 3
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 10; column += 1) {
      total = (total + swarmFlag(m, index)) & 0xff;
      index = (index + 1) & 0xff;
    }
    index = (index + 6) & 0xff; // $16CC, on to the next row's column 3
  }

  let oscillator = 0;
  let remaining = 3;
  for (;;) {
    total = (total - 1) & 0xff; // $16D6, the loop head
    if (total === 0) {
      // $16ED: out of aliens, so silence whatever is left of the three.
      for (; remaining > 0; remaining -= 1, oscillator += 1) {
        m.write(PORT.SOUND_BASE + oscillator, 0);
      }
      break;
    }
    m.write(PORT.SOUND_BASE + oscillator, 1);
    oscillator += 1;
    remaining -= 1;
    if (remaining === 0) break;
  }

  m.poke(VAR.HAVE_AGGRESSIVE_ALIENS, total < 2 ? 1 : 0); // $16DE cp $02 / jr c
}
