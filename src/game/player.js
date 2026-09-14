/**
 * The player ship: movement, firing, death and respawn.
 *
 * Two things about the ship are surprising until you have read the original.
 *
 * First, the ship is not a sprite. It is four character columns (26-29) of the
 * tilemap, and "moving" it means writing a per-column scroll offset into the
 * OBJRAM back buffer at $4054-$405B. The hardware scrolls those columns; the
 * characters themselves never move. @see reference/galaxian.asm:2440-2454
 *
 * Second, the monitor is rotated 90 degrees, so PLAYER_Y is the *horizontal*
 * axis and it counts up towards the LEFT of the screen. Pushing the stick right
 * decrements it. @see reference/galaxian.asm:69-86, 2414-2424
 */

import { VAR, BLOCK } from '../machine/addresses.js';
import { ALIEN_ATTACK_COUNTER_DEFAULTS } from './tables.js';

/**
 * Command ids accepted by QUEUE_COMMAND ($08F2), as documented in the listing's
 * own remarks block. @see reference/galaxian.asm:2588-2598
 */
export const COMMAND = Object.freeze({
  DRAW_ALIEN: 0,
  DELETE_ALIEN: 1,
  DISPLAY_PLAYER: 2,
  UPDATE_PLAYER_SCORE: 3,
  RESET_SCORE: 4,
  DISPLAY_SCORE: 5,
  PRINT_TEXT: 6,
  BOTTOM_OF_SCREEN_INFO: 7,
});

/**
 * QUEUE_COMMAND ($08F2), as this module sees it. The signature mirrors the
 * ROM's calling convention exactly: D is the command id, E is its parameter.
 * @typedef {(m: import('../machine/machine.js').Machine,
 *   command: number, parameter: number) => void} QueueCommandFn
 */

/** Stand-in until the command queue module is wired up. @type {QueueCommandFn} */
let queueCommand = () => {};

/**
 * Wire this module's scoring/display side effects to the real command queue.
 * @param {QueueCommandFn} fn
 */
export function setQueueCommand(fn) { queueCommand = fn; }

/** First of the four back-buffer column registers carrying the ship. */
const SHIP_SCROLL_FIRST = 0x4054;
/** Ship colour while alive ($0869) and while exploding ($0887). */
const SHIP_COLOUR_ALIVE = 0x06;
const SHIP_COLOUR_EXPLODING = 0x07;

/** $4010/$4011 bit positions the movement code tests. @see .asm:2418, 2426 */
const JOY_LEFT = 0x04;
const JOY_RIGHT = 0x08;
const JOY_SHOOT = 0x10;

/**
 * HANDLE_PLAYER_MOVE ($0837).
 *
 * Reads one of three control sources and applies at most one pixel of movement
 * per direction per frame -- there is no acceleration and no sub-pixel state,
 * which is why the ship feels so rigid. Both directions are tested in the same
 * pass, so holding left and right together cancels out exactly.
 *
 * @see reference/galaxian.asm:2402-2439, 2480-2483
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerMove(m) {
  // $083A: not spawned yet (or dying) -- the ship still needs a scroll value.
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) { spawnPlayerOrDie(m); return; }

  // $0840: in attract mode the "joystick" is a byte the demo AI writes.
  // Note this path skips the cocktail test entirely ($0892 jumps past it).
  let buttons;
  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) {
    buttons = m.peek(VAR.ATTRACT_MODE_FAKE_CONTROLLER);
  } else if ((m.peek(VAR.DISPLAY_IS_COCKTAIL_P2) & 1) !== 0) {
    buttons = m.peek(VAR.PORT_STATE_6800); // $088C
  } else {
    buttons = m.peek(VAR.PORT_STATE_6000); // $084D
  }

  // $0851: right. `cp $17 / jr c` blocks the decrement at $16, so $16 is the
  // lowest reachable value -- the bound is one below the compared constant.
  if ((buttons & JOY_RIGHT) !== 0) {
    const y = m.peek(VAR.PLAYER_Y);
    if (y >= 0x17) m.poke(VAR.PLAYER_Y, y - 1);
  }
  testJoystickPushedLeft(m, buttons);
}

/**
 * TEST_JOYSTICK_PUSHED_LEFT ($085B).
 *
 * Entered with the control byte still in B, so it is a continuation of
 * HANDLE_PLAYER_MOVE rather than a routine of its own, and it always falls
 * through into the scroll write.
 *
 * @see reference/galaxian.asm:2427-2437
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} buttons the joystick byte held in B
 */
export function testJoystickPushedLeft(m, buttons) {
  if ((buttons & JOY_LEFT) !== 0) {
    // $0860: `cp $E9 / jr nc` blocks the increment at $E9, so $E9 is the
    // highest reachable value -- the bound is the compared constant itself.
    const y = m.peek(VAR.PLAYER_Y);
    if (y < 0xe9) m.poke(VAR.PLAYER_Y, y + 1);
  }
  setPlayerShipScrollOffset(m);
}

/**
 * SET_PLAYER_SHIP_SCROLL_OFFSET ($0865): position the live ship.
 * @see reference/galaxian.asm:2441-2454
 * @param {import('../machine/machine.js').Machine} m
 */
export function setPlayerShipScrollOffset(m) {
  writeShipScrollColumns(m, shipScrollByte(m), SHIP_COLOUR_ALIVE);
}

/**
 * PLAYER_EXPLOSION_INIT ($0882, colour loaded at $0887): identical to the above
 * but paints the four columns in colour 7 so the explosion reads as white.
 * @see reference/galaxian.asm:2470-2477
 * @param {import('../machine/machine.js').Machine} m
 */
export function playerExplosionInit(m) {
  writeShipScrollColumns(m, shipScrollByte(m), SHIP_COLOUR_EXPLODING);
}

/**
 * SPAWN_PLAYER_OR_DIE ($0877).
 *
 * The tail of HANDLE_PLAYER_MOVE for the frames when there is no live ship. If
 * the player is mid-explosion the ship stays where it died; otherwise PLAYER_Y
 * is forced to 0, parking the (invisible) ship hard against the left edge so
 * that it does not flash into view at its old position when it respawns.
 *
 * @see reference/galaxian.asm:2456-2468
 * @param {import('../machine/machine.js').Machine} m
 */
export function spawnPlayerOrDie(m) {
  if ((m.peek(VAR.IS_PLAYER_DYING) & 1) !== 0) { playerExplosionInit(m); return; }
  m.poke(VAR.PLAYER_Y, 0);
  setPlayerShipScrollOffset(m);
}

/**
 * `cpl / add a,$80` on PLAYER_Y. Equivalently (127 - y) & 0xff.
 * @param {import('../machine/machine.js').Machine} m
 * @returns {number}
 */
function shipScrollByte(m) {
  return ((~m.peek(VAR.PLAYER_Y)) + 0x80) & 0xff;
}

/**
 * The four-column write loop shared by $0865 and $0882 ($086B onwards). The
 * ship is 2x2 characters alive and 4x4 exploding, and all four columns are
 * written either way.
 * @see reference/galaxian.asm:2447-2454
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} scroll
 * @param {number} colour
 */
function writeShipScrollColumns(m, scroll, colour) {
  for (let i = 0; i < 4; i += 1) {
    m.poke(SHIP_SCROLL_FIRST + i * 2, scroll);
    m.poke(SHIP_SCROLL_FIRST + i * 2 + 1, colour);
  }
}

/**
 * HANDLE_PLAYER_SHOOT ($0A32).
 *
 * One bullet at a time, and only on the rising edge of the fire button --
 * `a = PORT_STATE & ~PREV_PORT_STATE` at $0A48 -- so holding fire gives you one
 * shot, not an auto-repeat. The demo player has no such restraint: it simply
 * fires whenever TIMING_VARIABLE is a multiple of 32.
 *
 * @see reference/galaxian.asm:2897-2938
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerShoot(m) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  if ((m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED) & 1) !== 0) return;

  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) {
    // $0A68: attract mode. Note it does NOT set PLAY_PLAYER_SHOOT_SOUND, which
    // is why the demo game is silent apart from the swarm hum.
    if ((m.peek(VAR.TIMING_VARIABLE) & 0x1f) !== 0) return;
    m.poke(VAR.HAS_PLAYER_BULLET_BEEN_FIRED, 1);
    return;
  }

  const cocktailP2 = (m.peek(VAR.DISPLAY_IS_COCKTAIL_P2) & 1) !== 0;
  const now = m.peek(cocktailP2 ? VAR.PORT_STATE_6800 : VAR.PORT_STATE_6000);
  const before = m.peek(cocktailP2 ? VAR.PREV_PORT_STATE_6800 : VAR.PREV_PORT_STATE_6000);
  if ((now & (~before & 0xff) & JOY_SHOOT) === 0) return;

  m.poke(VAR.HAS_PLAYER_BULLET_BEEN_FIRED, 1);
  m.poke(VAR.PLAY_PLAYER_SHOOT_SOUND, 1);
}

/**
 * HANDLE_PLAYER_HIT ($12ED).
 *
 * Runs the frame after a collision routine set IS_PLAYER_HIT. Besides the
 * obvious bookkeeping it does one thing players never notice: the game gets
 * measurably *easier* every time you die, because DIFFICULTY_EXTRA_VALUE is
 * decremented here.
 *
 * @see reference/galaxian.asm:4685-4724
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerHit(m) {
  if ((m.peek(VAR.IS_PLAYER_HIT) & 1) === 0) return;
  m.poke(VAR.IS_PLAYER_HIT, 0);

  // $12F5: `ld hl,$0100 / ld ($4200),hl` clears HAS_PLAYER_SPAWNED and sets
  // IS_PLAYER_DYING in one 16-bit store.
  m.poke16(VAR.HAS_PLAYER_SPAWNED, 0x0100);
  // $12FB: likewise counter = $0A, anim frame = $04.
  m.poke16(VAR.PLAYER_EXPLOSION_COUNTER, 0x040a);
  queueCommand(m, COMMAND.DISPLAY_PLAYER, 5);

  // $1307-$130E. Scott flags the `jr z` as mis-targeted: when the value is
  // already zero the routine still writes it back. Harmless, but it is real,
  // and a byte-for-byte comparison would notice if we "fixed" it.
  const extra = m.peek(VAR.DIFFICULTY_EXTRA_VALUE);
  m.poke(VAR.DIFFICULTY_EXTRA_VALUE, extra === 0 ? 0 : extra - 1);

  // $1311: decrement, then clamp anything >= 6 down to 5. Only reachable
  // through an underflow, which is presumably the point.
  const lives = (m.peek(VAR.PLAYER_LIVES) - 1) & 0xff;
  m.poke(VAR.PLAYER_LIVES, lives >= 6 ? 5 : lives);

  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) return;
  m.write(0x6803, 1); // PLAYER HIT noise on
}

/**
 * HANDLE_PLAYER_DYING ($1327).
 *
 * Five images ten frames apart: the one queued by HANDLE_PLAYER_HIT with
 * parameter 5, then 4, 3, 2 and finally 1, which is ERASE_PLAYER_SHIP. Forty
 * frames of dying in total, and only then does IS_PLAYER_DYING clear and the
 * explosion noise stop.
 *
 * @see reference/galaxian.asm:4729-4753
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerDying(m) {
  if ((m.peek(VAR.IS_PLAYER_DYING) & 1) === 0) return;

  const counter = (m.peek(VAR.PLAYER_EXPLOSION_COUNTER) - 1) & 0xff;
  m.poke(VAR.PLAYER_EXPLOSION_COUNTER, counter);
  if (counter !== 0) return;
  m.poke(VAR.PLAYER_EXPLOSION_COUNTER, 0x0a);

  const frame = m.peek(VAR.PLAYER_EXPLOSION_ANIM_FRAME);
  queueCommand(m, COMMAND.DISPLAY_PLAYER, frame);
  const next = (frame - 1) & 0xff;
  m.poke(VAR.PLAYER_EXPLOSION_ANIM_FRAME, next);
  if (next !== 0) return;

  m.poke(VAR.IS_PLAYER_DYING, 0);
  m.write(0x6803, 0); // PLAYER HIT noise off
}

/**
 * HANDLE_SPAWN_PLAYER ($0614).
 *
 * A script stage, not a per-frame handler: it burns down TEMP_COUNTER_2 and on
 * the frame it reaches zero it advances SCRIPT_STAGE and puts a fresh ship on
 * the screen at PLAYER_Y = $80 (centre).
 *
 * Resetting all sixteen ALIEN_ATTACK_COUNTERS here is what gives you a moment
 * of peace after respawning -- every alien's attack timer restarts from its
 * reload value. @see reference/galaxian.asm:1932-1944
 *
 * @see reference/galaxian.asm:1932-1944
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSpawnPlayer(m) {
  const counter = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_2, counter);
  if (counter !== 0) return;

  m.poke(VAR.TEMP_COUNTER_2, 0x0a);
  m.poke(VAR.SCRIPT_STAGE, (m.peek(VAR.SCRIPT_STAGE) + 1) & 0xff);

  // $061D: one 16-bit store sets HAS_PLAYER_SPAWNED and clears IS_PLAYER_DYING.
  m.poke16(VAR.HAS_PLAYER_SPAWNED, 0x0001);
  m.poke(VAR.PLAYER_Y, 0x80);

  for (let i = 0; i < BLOCK.ALIEN_ATTACK_COUNTERS.size; i += 1) {
    m.poke(BLOCK.ALIEN_ATTACK_COUNTERS.addr + i, ALIEN_ATTACK_COUNTER_DEFAULTS[i]);
  }

  // $0633: two of the ship's four scroll columns are zeroed. The other two are
  // left alone; DISPLAY_PLAYER_COMMAND is about to redraw the ship anyway.
  m.poke(0x4058, 0);
  m.poke(0x405a, 0);

  queueCommand(m, COMMAND.BOTTOM_OF_SCREEN_INFO, 3); // DISPLAY_PLAYER_SHIPS_REMAINING
  queueCommand(m, COMMAND.DISPLAY_PLAYER, 0); // DRAW_PLAYER_SHIP
}
