/**
 * The alien formation: how it is stored, how it slides from side to side, and
 * the per-frame flags derived from it that the rest of the game reads.
 *
 * Two routines run before anything else every frame, ahead of even the script
 * dispatch: HANDLE_SWARM_MOVEMENT then SET_ALIEN_PRESENCE_FLAGS.
 * @see reference/galaxian.asm:1778-1780, 2646-2894
 *
 * Geometry worth keeping in mind, because the memory image is upside down *and*
 * mirrored relative to the screen (reference/galaxian.asm:327-356):
 *
 *   index = row * 16 + column,  rows 2-7, columns 3-12
 *   row 7 flagships, row 6 red, row 5 purple, rows 4/3/2 blue
 *   COLUMN 3 IS THE RIGHTMOST ON SCREEN; column 12 is the leftmost
 */

import { VAR, BLOCK } from '../machine/addresses.js';

/** Rows and columns the game actually uses. */
export const ROW_MIN = 2;
export const ROW_MAX = 7;
export const COL_MIN = 3;
export const COL_MAX = 12;

/** Scroll extents for a full swarm; each empty edge column adds 16px of travel. */
export const SCROLL_LEFT_LIMIT_BASE = 0x22;
export const SCROLL_RIGHT_LIMIT_BASE = 0xe0;

/** The nine character columns the swarm occupies, whose scroll registers move. */
export const SCROLL_REGISTER_COUNT = 9;
const SCROLL_REGISTER_FIRST = 0x4028;

/**
 * UNPACK_ALIEN_SWARM ($0646): 16 bytes to 128 flags, least significant bit
 * first. Used to lay out a fresh wave and to restore a player's swarm when
 * their turn comes round again.
 * @see reference/galaxian.asm:2021-2037
 * @param {import('../machine/machine.js').Machine} m
 * @param {ArrayLike<number>} packed 16 bytes
 */
export function unpackAlienSwarm(m, packed) {
  let index = 0;
  for (let byte = 0; byte < 16; byte += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + index, (packed[byte] >> bit) & 1);
      index += 1;
    }
  }
}

/**
 * PACK_ALIEN_SWARM ($0764): the exact inverse, so a player's half-cleared wave
 * survives their opponent's turn.
 * @see reference/galaxian.asm:2227-2241
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} destAddr where to write the 16 packed bytes
 */
export function packAlienSwarm(m, destAddr) {
  for (let byte = 0; byte < 16; byte += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      if (m.peek(BLOCK.ALIEN_SWARM_FLAGS.addr + byte * 8 + bit) & 1) value |= 1 << bit;
    }
    m.poke(destAddr + byte, value);
  }
}

/**
 * SET_SWARM_SCROLL_OFFSET ($0972): write the same scroll byte into the nine
 * column registers of the back buffer that carry the swarm.
 * @see reference/galaxian.asm:2723-2730
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} offset
 */
export function setSwarmScrollOffset(m, offset) {
  for (let i = 0; i < SCROLL_REGISTER_COUNT; i += 1) {
    m.poke(SCROLL_REGISTER_FIRST + i * 2, offset);
  }
}

/**
 * HANDLE_SWARM_MOVEMENT ($090D).
 *
 * Two jobs. First, freeze the whole formation while the player's bullet is
 * climbing through a column that still holds aliens -- that is the subtle
 * behaviour that lets you lead a shot and have the target stay put. Second,
 * advance the scroll one pixel every fourth frame and reverse at the extents.
 *
 * @see reference/galaxian.asm:2646-2711
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSwarmMovement(m) {
  if (isSwarmFrozenByPlayerBullet(m)) {
    // $0988: rewrite the scroll registers from the unchanged value and return,
    // so the formation holds position for this frame.
    setSwarmScrollOffset(m, (-(m.peek(VAR.SWARM_SCROLL_VALUE) & 0xff)) & 0xff);
    return;
  }

  let scroll = m.peek16(VAR.SWARM_SCROLL_VALUE);
  const leftLimit = m.peek(VAR.SWARM_SCROLL_MAX_EXTENTS);
  const rightLimit = m.peek(VAR.SWARM_SCROLL_MAX_EXTENTS + 1);
  const movingLeft = m.peek(VAR.SWARM_DIRECTION) === 0;
  const lo = scroll & 0xff;
  const negative = (scroll & 0x8000) !== 0;

  if (movingLeft) {
    // $094B-$0951: `bit 7,h` then an unsigned `cp e` on the low byte.
    if (!negative && lo >= leftLimit) { m.poke(VAR.SWARM_DIRECTION, 1); return; }
    if (m.peek(VAR.TIMING_VARIABLE) & 3) return; // one pixel every fourth frame
    scroll = (scroll + 1) & 0xffff;
  } else {
    if (negative && lo < rightLimit) { m.poke(VAR.SWARM_DIRECTION, 0); return; }
    if (m.peek(VAR.TIMING_VARIABLE) & 3) return;
    scroll = (scroll - 1) & 0xffff;
  }

  m.poke16(VAR.SWARM_SCROLL_VALUE, scroll);
  setSwarmScrollOffset(m, (-(scroll & 0xff)) & 0xff);
}

/**
 * The bullet-proximity freeze test from the head of HANDLE_SWARM_MOVEMENT.
 * @see reference/galaxian.asm:2647-2677
 * @param {import('../machine/machine.js').Machine} m
 * @returns {boolean}
 */
function isSwarmFrozenByPlayerBullet(m) {
  if ((m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED) & 1) === 0) return false;

  // $0916: only while the bullet is inside the band the formation occupies.
  if (((m.peek(VAR.PLAYER_BULLET_X) - 0x22) & 0xff) >= 0x50) return false;

  // $091D-$0921: `ld a,(scroll) / sub (bulletY) / neg` == bulletY - scrollLo.
  const offset = (m.peek(VAR.PLAYER_BULLET_Y) - m.peek(VAR.SWARM_SCROLL_VALUE)) & 0xff;

  // $0924: the bullet must be lined up with a column, not in the gap between.
  if (((offset + 2) & 0x0f) >= 3) return false;

  const column = (offset >> 4) & 0x0f;
  return (m.peek(BLOCK.ALIEN_IN_COLUMN_FLAGS.addr + column) & 1) !== 0;
}

/**
 * SET_ALIEN_PRESENCE_FLAGS ($098E).
 *
 * Runs immediately after the movement routine and recomputes everything the
 * rest of the frame depends on: which rows and columns still hold aliens, how
 * far the formation may now scroll, and the four "is anything left" flags.
 *
 * @see reference/galaxian.asm:2764-2894
 * @param {import('../machine/machine.js').Machine} m
 */
export function setAlienPresenceFlags(m) {
  const flags = BLOCK.ALIEN_SWARM_FLAGS.addr;

  // (a) Row flags. $41E8 and $41E9 are cleared and never read; the real six
  // start at $41EA (bottom blue row) and run up to $41EF (flagships).
  m.poke(BLOCK.HAVE_ALIENS_IN_ROW_FLAGS.addr, 0);
  m.poke(BLOCK.HAVE_ALIENS_IN_ROW_FLAGS.addr + 1, 0);
  /** @type {number[]} */
  const rowOccupied = [];
  for (let row = ROW_MIN; row <= ROW_MAX; row += 1) {
    let any = 0;
    for (let col = COL_MIN; col <= COL_MAX; col += 1) any |= m.peek(flags + row * 16 + col);
    rowOccupied[row] = any & 1;
    m.poke(BLOCK.HAVE_ALIENS_IN_ROW_FLAGS.addr + 2 + (row - ROW_MIN), any & 1);
  }

  // (b) Column flags, stored at $41F0 + column so index 3 is the rightmost.
  /** @type {number[]} */
  const colOccupied = [];
  for (let col = 0; col < 16; col += 1) {
    let any = 0;
    if (col >= COL_MIN && col <= COL_MAX) {
      for (let row = ROW_MIN; row <= ROW_MAX; row += 1) any |= m.peek(flags + row * 16 + col);
    }
    colOccupied[col] = any & 1;
    m.poke(BLOCK.ALIEN_IN_COLUMN_FLAGS.addr + col, any & 1);
  }

  // (c) Scroll extents. Every empty column at an edge buys the formation
  // another 16 pixels of travel on that side, which is why a nearly-cleared
  // wave sweeps much further than a full one.
  let leftLimit = SCROLL_LEFT_LIMIT_BASE;
  for (let col = COL_MAX; col >= COL_MIN; col -= 1) {
    if (colOccupied[col]) break;
    leftLimit = (leftLimit + 0x10) & 0xff;
  }
  let rightLimit = SCROLL_RIGHT_LIMIT_BASE;
  for (let col = COL_MIN; col <= COL_MAX; col += 1) {
    if (colOccupied[col]) break;
    rightLimit = (rightLimit - 0x10) & 0xff;
  }
  const empty = !colOccupied.some((v, i) => v && i >= COL_MIN && i <= COL_MAX);
  if (empty) { leftLimit = SCROLL_LEFT_LIMIT_BASE; rightLimit = SCROLL_RIGHT_LIMIT_BASE; }
  m.poke(VAR.SWARM_SCROLL_MAX_EXTENTS, leftLimit);
  m.poke(VAR.SWARM_SCROLL_MAX_EXTENTS + 1, rightLimit);

  // (d) Global flags.
  const noBlueOrPurple = !(rowOccupied[2] || rowOccupied[3] || rowOccupied[4] || rowOccupied[5]);
  m.poke(VAR.HAVE_NO_BLUE_OR_PURPLE_ALIENS, noBlueOrPurple ? 1 : 0);
  const noneInSwarm = noBlueOrPurple && !rowOccupied[6] && !rowOccupied[7];
  m.poke(VAR.HAVE_NO_ALIENS_IN_SWARM, noneInSwarm ? 1 : 0);

  // Note the asymmetry, which is in the original: the IsActive scan skips slot
  // 0 (it is the shared explosion scratch, never a flying alien), but the
  // IsDying scan includes it. @see reference/galaxian.asm:2875, 2887
  const aliens = BLOCK.INFLIGHT_ALIENS.addr;
  let anyActive = 0;
  for (let slot = 1; slot < 8; slot += 1) anyActive |= m.peek(aliens + slot * 32);
  m.poke(VAR.HAVE_NO_INFLIGHT_ALIENS, (anyActive & 1) ? 0 : 1);

  let anyDying = 0;
  for (let slot = 0; slot < 8; slot += 1) anyDying |= m.peek(aliens + slot * 32 + 1);
  m.poke(VAR.HAVE_NO_INFLIGHT_OR_DYING_ALIENS, ((anyActive | anyDying) & 1) ? 0 : 1);
}

/**
 * How many aliens are left in the formation body.
 * @param {import('../machine/machine.js').Machine} m
 * @returns {number} 0-46
 */
export function swarmCount(m) {
  let count = 0;
  for (let row = ROW_MIN; row <= ROW_MAX; row += 1) {
    for (let col = COL_MIN; col <= COL_MAX; col += 1) {
      count += m.peek(BLOCK.ALIEN_SWARM_FLAGS.addr + row * 16 + col) & 1;
    }
  }
  return count;
}
