/**
 * All four collision tests, in the order the main loop runs them.
 *
 * There is no shared collision engine: each of the four pairings has its own
 * hand-written test with its own hit box, and none of them is symmetric or
 * centred the way a modern engine would make it. The windows below are not
 * approximations -- they are exactly what the `add`/`sub`/`cp` chains in the
 * ROM accept, and every one of them is verified against the Z80 oracle by
 * sweeping the whole neighbourhood of a target.
 *
 * A recurring idiom: `a = p - q; a += k; cp n; ret nc` accepts the window
 * `-k <= (p - q) <= n - k - 1`, in 8-bit wraparound arithmetic. Two of the four
 * tests use a *pair* of such windows, a narrow one for the nose of the target
 * and a wide one for its body.
 *
 * @see reference/galaxian.asm:3043-3173, 4536-4679
 */

import { VAR, BLOCK, ENEMY_BULLET, INFLIGHT_ALIEN } from '../machine/addresses.js';

/**
 * Command ids, repeated here so this module does not depend on the player
 * module for a constant. @see reference/galaxian.asm:2588-2598
 */
export const COMMAND = Object.freeze({
  DELETE_ALIEN: 1,
  UPDATE_PLAYER_SCORE: 3,
});

/**
 * QUEUE_COMMAND ($08F2), as this module sees it. D is the command id, E is its
 * parameter, exactly as in the ROM.
 * @typedef {(m: import('../machine/machine.js').Machine,
 *   command: number, parameter: number) => void} QueueCommandFn
 */

/** Stand-in until the command queue module is wired up. @type {QueueCommandFn} */
let queueCommand = () => {};

/**
 * Wire this module's scoring side effects to the real command queue.
 * @param {QueueCommandFn} fn
 */
export function setQueueCommand(fn) { queueCommand = fn; }

/** Slot 0 of INFLIGHT_ALIENS is the shared explosion scratch. @see .asm:576-583 */
const EXPLOSION_SLOT = 0;
/** Collision scans cover slots 1..7. */
const FIRST_FLYING_SLOT = 1;
const FLYING_SLOT_COUNT = 7;

/** @param {number} slot @returns {number} record address */
function alienAddr(slot) {
  return BLOCK.INFLIGHT_ALIENS.addr + slot * INFLIGHT_ALIEN.SIZE;
}

/**
 * HANDLE_SWARM_ALIEN_TO_PLAYER_BULLET_COLLISION_DETECTION ($0B0B).
 *
 * The formation is not searched as a list of objects; the bullet's X is walked
 * down a chain of subtractions that peels off one row at a time, and its Y is
 * turned into a column index by arithmetic on the swarm scroll. Constant time,
 * six iterations at worst, no matter how many aliens are left.
 *
 * @see reference/galaxian.asm:3043-3119
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSwarmAlienToPlayerBulletCollisionDetection(m) {
  if ((m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED) & 1) === 0) return;

  const bulletX = m.peek(VAR.PLAYER_BULLET_X);
  if (bulletX >= 0x68) return; // $0B13: not down to the formation yet
  if (bulletX < 0x1e) return; // $0B16: already past it

  // $0B19: six rows, each a 7-pixel gap followed by a 5-pixel band. Row 6 is
  // the flagships (X 37-41), row 1 the bottom blue row (X 97-101).
  let acc = (bulletX - 0x1e) & 0xff;
  let row = 6;
  for (;;) {
    if (acc < 7) return; // borrow: the bullet is in a gap between rows
    acc = (acc - 7) & 0xff;
    if (acc < 5) break; // borrow: the bullet is inside this row's band
    acc = (acc - 5) & 0xff;
    row -= 1;
    if (row === 0) return; // $0B24: fell off the bottom of the formation
  }

  // $0B26: `ld a,(scroll) / sub (bulletY) / neg` == bulletY - scroll, i.e. the
  // bullet's position within the formation's own coordinate frame.
  const offset = (m.peek(VAR.PLAYER_BULLET_Y) - m.peek(VAR.SWARM_SCROLL_VALUE)) & 0xff;

  // $0B2D: the alien sits at offset 7 within its 16-pixel cell, and the window
  // is cell offsets 2..12 -- so the box is 11 wide but leans 5 one way and 5
  // the other around 7, with an extra pixel on the low side.
  if ((((offset & 0x0f) - 2) & 0xff) >= 0x0b) return;

  // $0B34: the row counter becomes the real swarm row (2..7), then the four
  // `rrca`s rebuild the index as (row << 4) | (offset >> 4).
  const swarmRow = row + 1;
  const rotated = ((offset & 0xf0) + swarmRow) & 0xff;
  const index = ((rotated & 0x0f) << 4) | (rotated >> 4);

  const cell = BLOCK.ALIEN_SWARM_FLAGS.addr + index;
  if ((m.peek(cell) & 1) === 0) return;

  m.poke(cell, 0);
  queueCommand(m, COMMAND.DELETE_ALIEN, index);
  m.poke(VAR.IS_PLAYER_BULLET_DONE, 1);

  // $0B52: the explosion borrows slot 0 of INFLIGHT_ALIENS and is drawn at the
  // bullet's position, not the alien's. Kill two aliens in quick succession and
  // the second explosion steals the sprite from the first.
  const scratch = alienAddr(EXPLOSION_SLOT);
  m.poke(scratch + INFLIGHT_ALIEN.IS_DYING, 1);
  m.poke(scratch + INFLIGHT_ALIEN.STAGE_OF_LIFE, 0);
  m.poke(scratch + INFLIGHT_ALIEN.X, bulletX);
  m.poke(scratch + INFLIGHT_ALIEN.Y, m.peek(VAR.PLAYER_BULLET_Y));

  // $0B5F: rows 2-4 (index < $50) are all blue and all worth 30; above that the
  // row number alone picks the score table entry.
  const param = index < 0x50 ? 0 : (((index & 0x70) >> 4) - 4);
  queueCommand(m, COMMAND.UPDATE_PLAYER_SCORE, param);
}

/**
 * HANDLE_PLAYER_TO_ENEMY_BULLET_COLLISION_DETECTION ($0B77): test all fourteen
 * bullet records, including the seven that were not moved this frame.
 * @see reference/galaxian.asm:3125-3136
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerToEnemyBulletCollisionDetection(m) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  for (let i = 0; i < ENEMY_BULLET.COUNT; i += 1) testIfEnemyBulletHitPlayer(m, i);
}

/**
 * TEST_IF_ENEMY_BULLET_HIT_PLAYER ($0B8D).
 *
 * The ship is treated as two boxes stacked vertically: a narrow nose you can
 * almost slip a bullet past, and a wide body you cannot. Because X counts DOWN
 * the screen and the ship lives near X 225-239, the *smaller* X band (225-229)
 * is the nose.
 *
 * @see reference/galaxian.asm:3146-3173
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} bulletSlot 0-13
 * @returns {boolean} true if this bullet hit
 */
export function testIfEnemyBulletHitPlayer(m, bulletSlot) {
  const addr = BLOCK.ENEMY_BULLETS.addr + bulletSlot * ENEMY_BULLET.SIZE;
  if ((m.peek(addr + ENEMY_BULLET.IS_ACTIVE) & 1) === 0) return false;

  const dy = (m.peek(VAR.PLAYER_Y) - m.peek(addr + ENEMY_BULLET.Y_HI)) & 0xff;

  // $0B92: `add a,$1F / sub e` with E held at 5 throughout the caller's loop.
  const band = (m.peek(addr + ENEMY_BULLET.X) + 0x1f) & 0xff;
  if (band < 5) {
    // $0BAA: nose, bullet X 225-229. Window PLAYER_Y-2 .. PLAYER_Y+2.
    if (((dy + 2) & 0xff) >= 5) return false;
  } else {
    // $0B9A: body, bullet X 230-238. Window PLAYER_Y-5 .. PLAYER_Y+5.
    if (((band - 5) & 0xff) >= 9) return false;
    if (((dy + 5) & 0xff) >= 0x0b) return false;
  }

  m.poke(addr + ENEMY_BULLET.IS_ACTIVE, 0);
  m.poke(VAR.IS_PLAYER_HIT, 1);
  return true;
}

/**
 * HANDLE_INFLIGHT_ALIEN_TO_PLAYER_BULLET_COLLISION_DETECTION ($1227).
 * @see reference/galaxian.asm:4535-4547
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleInflightAlienToPlayerBulletCollisionDetection(m) {
  if ((m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED) & 1) === 0) return;
  for (let i = 0; i < FLYING_SLOT_COUNT; i += 1) {
    testIfPlayerBulletHitInflightAlien(m, FIRST_FLYING_SLOT + i);
  }
}

/**
 * TEST_IF_PLAYER_BULLET_HIT_INFLIGHT_ALIEN ($123F).
 *
 * A single box, 6 px down-screen by 12 px across. Note it is not centred: the
 * vertical window is -2..+3 and the horizontal one -5..+6, both leaning one
 * pixel towards higher alien coordinates.
 *
 * @see reference/galaxian.asm:4556-4589
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot index into INFLIGHT_ALIENS
 * @returns {boolean} true if this alien was hit
 */
export function testIfPlayerBulletHitInflightAlien(m, slot) {
  const addr = alienAddr(slot);
  if ((m.peek(addr + INFLIGHT_ALIEN.IS_ACTIVE) & 1) === 0) return false;

  const dx = (m.peek(addr + INFLIGHT_ALIEN.X) - m.peek(VAR.PLAYER_BULLET_X)) & 0xff;
  if (((dx + 2) & 0xff) >= 6) return false;
  const dy = (m.peek(addr + INFLIGHT_ALIEN.Y) - m.peek(VAR.PLAYER_BULLET_Y)) & 0xff;
  if (((dy + 5) & 0xff) >= 0x0c) return false;

  m.poke(VAR.IS_PLAYER_BULLET_DONE, 1);
  killInflightAlienAndScore(m, slot);
  return true;
}

/**
 * The shared tail at $125E: retire the alien, start its death animation, and
 * work out what it was worth. Reached both by shooting an alien and by flying
 * into one -- which is why ramming still scores.
 *
 * @see reference/galaxian.asm:4570-4610
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function killInflightAlienAndScore(m, slot) {
  const addr = alienAddr(slot);
  m.poke(addr + INFLIGHT_ALIEN.IS_ACTIVE, 0);
  m.poke(addr + INFLIGHT_ALIEN.IS_DYING, 1);
  m.poke(addr + INFLIGHT_ALIEN.STAGE_OF_LIFE, 0);

  // $126D: subtract a row at a time from the swarm index, raising the score
  // parameter each time, until the alien falls below the blue threshold.
  // Three tries, so only a flagship (index >= $70) survives the loop.
  let param = 4;
  let index = m.peek(addr + INFLIGHT_ALIEN.INDEX_IN_SWARM);
  for (let tries = 3; tries > 0; tries -= 1) {
    if (index < 0x50) { queueCommand(m, COMMAND.UPDATE_PLAYER_SCORE, param); return; }
    param += 1;
    index = (index - 0x10) & 0xff;
  }

  // $127C: a downed flagship stuns the whole swarm for 240 frames -- no alien
  // leaves the formation and no alien fires while IS_FLAGSHIP_HIT is set.
  m.poke16(VAR.IS_FLAGSHIP_HIT, 0xf001);

  let factor = m.peek(VAR.FLAGSHIP_ESCORT_COUNT);
  if (factor === 2) factor = assertBothFlagshipEscortsAreAlive(m, slot, factor);
  m.poke(VAR.FLAGSHIP_SCORE_FACTOR, factor);
  queueCommand(m, COMMAND.UPDATE_PLAYER_SCORE, (factor + param) & 0xff);
}

/**
 * ASSERT_BOTH_FLAGSHIP_ESCORTS_ARE_ALIVE ($1292).
 *
 * The 800-point shot. A flagship that launched with two escorts is worth 300 if
 * either escort is still flying and 800 only if you shot both of them first --
 * the routine bumps the score factor from 2 to 3 exactly when neither escort
 * slot is active any more.
 *
 * The escorts are found by structure offset, not by search: +$20 and +$40 from
 * the flagship's own record, i.e. the next two slots.
 *
 * @see reference/galaxian.asm:4613-4622
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot the flagship's slot
 * @param {number} a the incoming FLAGSHIP_ESCORT_COUNT, always 2 here
 * @returns {number} 2 if an escort is still alive, otherwise 3
 */
export function assertBothFlagshipEscortsAreAlive(m, slot, a) {
  if ((m.peek(alienAddr(slot + 1) + INFLIGHT_ALIEN.IS_ACTIVE) & 1) !== 0) return a;
  if ((m.peek(alienAddr(slot + 2) + INFLIGHT_ALIEN.IS_ACTIVE) & 1) !== 0) return a;
  return (a + 1) & 0xff;
}

/**
 * HANDLE_PLAYER_TO_INFLIGHT_ALIEN_COLLISION_DETECTION ($129E).
 * @see reference/galaxian.asm:4626-4640
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerToInflightAlienCollisionDetection(m) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  for (let i = 0; i < FLYING_SLOT_COUNT; i += 1) {
    testIfInflightAlienHitPlayer(m, FIRST_FLYING_SLOT + i);
  }
}

/**
 * TEST_IF_INFLIGHT_ALIEN_HIT_PLAYER ($12B6).
 *
 * The same nose/body split as the enemy-bullet test but with much larger boxes,
 * and the split sits two pixels higher: alien X 223-227 is the narrow band,
 * 228-239 the wide one. Both are far wider than the ship actually looks, which
 * is why near-misses so often kill you.
 *
 * @see reference/galaxian.asm:4650-4679
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot index into INFLIGHT_ALIENS
 * @returns {boolean} true if this alien hit the player
 */
export function testIfInflightAlienHitPlayer(m, slot) {
  const addr = alienAddr(slot);
  if ((m.peek(addr + INFLIGHT_ALIEN.IS_ACTIVE) & 1) === 0) return false;

  const dy = (m.peek(VAR.PLAYER_Y) - m.peek(addr + INFLIGHT_ALIEN.Y)) & 0xff;
  const band = (m.peek(addr + INFLIGHT_ALIEN.X) + 0x21) & 0xff;
  if (band < 5) {
    // $12DA: nose, alien X 223-227. Window PLAYER_Y +/- 7.
    if (((dy + 7) & 0xff) >= 0x0f) return false;
  } else {
    // $12C4: body, alien X 228-239. Window PLAYER_Y +/- 10.
    if (((band - 5) & 0xff) >= 0x0c) return false;
    if (((dy + 0x0a) & 0xff) >= 0x15) return false;
  }

  m.poke(VAR.IS_PLAYER_HIT, 1);
  // $12D7/$12EA both `jp $125E`: ramming an alien kills it and pays out.
  killInflightAlienAndScore(m, slot);
  return true;
}
