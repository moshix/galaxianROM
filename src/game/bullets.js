/**
 * Every bullet in the game: the player's single missile and the aliens' 14.
 *
 * The player's bullet is trivial -- one object, straight up, four pixels a
 * frame. The enemy bullets are the interesting half, because there are 14 of
 * them and only 8 hardware bullet objects, one of which is the player's. The
 * original solves this by updating and drawing only seven of the fourteen each
 * frame, alternating. The resulting flicker is not a bug in this port; it is
 * what the arcade machine looks like.
 * @see reference/galaxian.asm:2948-3034
 *
 * Coordinates are hardware coordinates throughout: X counts DOWN the screen,
 * Y counts LEFT. @see reference/galaxian.asm:69-86
 */

import { VAR, BLOCK, ENEMY_BULLET, INFLIGHT_ALIEN } from '../machine/addresses.js';
import { generateRandomNumber, calculateTangent, int8 } from './rng.js';

/** Where the muzzle is: the bullet sits here while un-fired. @see .asm:2545 */
export const PLAYER_BULLET_SPAWN_X = 0xdc;

/** IY starts one byte into the bullet back buffer; Y is +0, X is +2. */
const BULLET_BACKBUF_FIRST = 0x4081;
/** Seven of the eight hardware bullet objects; the eighth is the player's. */
const ENEMY_BULLET_SPRITES = 7;

/**
 * HANDLE_PLAYER_BULLET ($0898): advance the bullet, then project it into the
 * OBJRAM back buffer.
 * @see reference/galaxian.asm:2493-2516
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerBullet(m) {
  positionPlayerBullet(m);

  // $089B: `ld hl,($4209)` picks up X in L and Y in H with one instruction.
  const x = m.peek(VAR.PLAYER_BULLET_X);
  const y = m.peek(VAR.PLAYER_BULLET_Y);

  if ((m.peek(VAR.DISPLAY_IS_COCKTAIL_P2) & 1) !== 0) {
    // $08B1: the screen is upside down for player 2, so X is not complemented.
    m.poke(BLOCK.OBJRAM_BUF_PLAYER_BULLET_X.addr, (x - 1) & 0xff);
    m.poke(BLOCK.OBJRAM_BUF_PLAYER_BULLET_Y.addr, (~y) & 0xff);
    return;
  }
  // $08A4: `cpl / add a,-4` == (251 - x) & 0xff.
  m.poke(BLOCK.OBJRAM_BUF_PLAYER_BULLET_X.addr, ((~x) - 4) & 0xff);
  m.poke(BLOCK.OBJRAM_BUF_PLAYER_BULLET_Y.addr, (~y) & 0xff);
}

/**
 * POSITION_PLAYER_BULLET ($08BC).
 *
 * While un-fired the bullet is re-parked at the muzzle every single frame, so
 * firing does not "create" anything -- it just stops the parking. That is why
 * the shot always leaves from exactly where the ship is at the instant you
 * press the button, with no spawn latency at all.
 *
 * @see reference/galaxian.asm:2524-2542
 * @param {import('../machine/machine.js').Machine} m
 */
export function positionPlayerBullet(m) {
  if ((m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED) & 1) === 0) {
    positionPlayerBulletAboveShip(m);
    return;
  }

  const x = (m.peek(VAR.PLAYER_BULLET_X) - 4) & 0xff;
  m.poke(VAR.PLAYER_BULLET_X, x);

  // $08C8: the expiry test is `sub $0E` then `sub $04` and only the SECOND
  // borrow is tested, so it is NOT "x < 18". It is `((x - 14) & 0xff) < 4`,
  // i.e. exactly x in 14..17 -- an x that skips that window sails on with the
  // coordinate wrapping round. In normal play x steps 220, 216, ... 16, which
  // lands inside the window, so the difference never shows; it shows the
  // moment anything else writes PLAYER_BULLET_X.
  if (((x - 0x0e) & 0xff) < 4) m.poke(VAR.IS_PLAYER_BULLET_DONE, 1);
}

/**
 * POSITION_PLAYER_BULLET_ABOVE_SHIP ($08D3).
 * @see reference/galaxian.asm:2544-2557
 * @param {import('../machine/machine.js').Machine} m
 */
export function positionPlayerBulletAboveShip(m) {
  m.poke(VAR.PLAYER_BULLET_X, PLAYER_BULLET_SPAWN_X);
  const spawned = (m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) !== 0;
  m.poke(VAR.PLAYER_BULLET_Y, spawned ? m.peek(VAR.PLAYER_Y) : 0);
}

/**
 * CHECK_IF_PLAYER_BULLET_EXPIRED ($08E5).
 *
 * The single point at which the player is re-armed, and it runs *after* all
 * four collision routines. A bullet that kills something this frame therefore
 * still costs you one frame before you can fire again.
 *
 * @see reference/galaxian.asm:2565-2574
 * @param {import('../machine/machine.js').Machine} m
 */
export function checkIfPlayerBulletExpired(m) {
  if ((m.peek(VAR.IS_PLAYER_BULLET_DONE) & 1) === 0) return;
  m.poke(VAR.IS_PLAYER_BULLET_DONE, 0);
  m.poke(VAR.HAS_PLAYER_BULLET_BEEN_FIRED, 0);
}

/**
 * HANDLE_ENEMY_BULLETS ($0A74).
 *
 * The 14-into-7 multiplex. IX starts at bullet 0 on odd frames and bullet 1 on
 * even frames, and the loop body steps IX by *two* records per iteration: it
 * fully updates one bullet (move, expire, steer, draw) and merely nudges the
 * next one's X by 2. So every bullet descends 2 px every frame, but its lateral
 * motion, its off-screen test and its sprite only refresh every other frame.
 *
 * One quirk to preserve: on even frames the seventh iteration nudges the record
 * *after* the last one, writing 2 into $42A7 -- three bytes past the end of the
 * array, in the unused gap before INFLIGHT_ALIENS. The original does this every
 * other frame for the whole life of the machine.
 *
 * @see reference/galaxian.asm:2948-3016
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleEnemyBullets(m) {
  let bullet = BLOCK.ENEMY_BULLETS.addr;

  // $0A78: `rrca / jr c` -- an ODD TIMING_VARIABLE keeps IX on bullet 0.
  if ((m.peek(VAR.TIMING_VARIABLE) & 1) === 0) {
    nudgeBulletX(m, bullet);
    bullet += ENEMY_BULLET.SIZE;
  }

  for (let b = ENEMY_BULLET_SPRITES; b >= 1; b -= 1) {
    updateOneEnemyBullet(m, bullet, b);
    bullet += ENEMY_BULLET.SIZE;
    nudgeBulletX(m, bullet); // $0AE7: the other 2 px for the skipped neighbour
    bullet += ENEMY_BULLET.SIZE;
  }
}

/**
 * `inc (ix+$01)` twice: the half-update a bullet gets on the frame it is not
 * otherwise touched.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr record address
 */
function nudgeBulletX(m, addr) {
  m.poke(addr + ENEMY_BULLET.X, m.peek(addr + ENEMY_BULLET.X) + 2);
}

/**
 * The body of the $0A8F loop for one bullet record.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr record address
 * @param {number} b the djnz counter, 7 down to 1; it selects the sprite quirk
 */
function updateOneEnemyBullet(m, addr, b) {
  let deactivate = (m.peek(addr + ENEMY_BULLET.IS_ACTIVE) & 1) === 0;

  if (!deactivate) {
    const x = (m.peek(addr + ENEMY_BULLET.X) + 2) & 0xff;
    m.poke(addr + ENEMY_BULLET.X, x);
    // $0A9D: `add a,$04` -- a carry here means the bullet has reached the
    // bottom of the screen, four pixels of sprite height early.
    if (x + 4 > 0xff) deactivate = true;
  }

  if (!deactivate) {
    // $0AA1: `rl e / sbc a,a` sign-extends YDelta while doubling it, so the
    // 16-bit increment is 2 * (int8)YDelta applied to the 8.8 fixed point
    // YH:YL pair. YH is the pixel, YL the fraction.
    const pos = m.peek(addr + ENEMY_BULLET.Y_LO) | (m.peek(addr + ENEMY_BULLET.Y_HI) << 8);
    const delta = (2 * int8(m.peek(addr + ENEMY_BULLET.Y_DELTA))) & 0xffff;
    const next = (pos + delta) & 0xffff;
    m.poke(addr + ENEMY_BULLET.Y_LO, next & 0xff);
    m.poke(addr + ENEMY_BULLET.Y_HI, next >> 8);
    // $0AB5: off either side. The 32-wide dead band around 0/240 is what makes
    // a bullet vanish just before it would wrap round to the other edge.
    if ((((next >> 8) + 0x10) & 0xff) < 0x20) deactivate = true;
  }

  if (deactivate) {
    // $0ABC. YL is deliberately left alone, so a reused slot inherits the old
    // fraction -- a one-pixel jitter the original never bothered to fix.
    m.poke(addr + ENEMY_BULLET.IS_ACTIVE, 0);
    m.poke(addr + ENEMY_BULLET.X, 0);
    m.poke(addr + ENEMY_BULLET.Y_HI, 0);
  }

  writeEnemyBulletSprite(m, addr, b);
}

/**
 * $0AC6-$0AE1: project the record into the bullet back buffer.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr record address
 * @param {number} b djnz counter, 7 down to 1
 */
function writeEnemyBulletSprite(m, addr, b) {
  // The sprite slot is derived from the loop counter: b = 7 is slot 0.
  const spriteAddr = BULLET_BACKBUF_FIRST + (ENEMY_BULLET_SPRITES - b) * 4;
  const x = m.peek(addr + ENEMY_BULLET.X);
  const yHi = m.peek(addr + ENEMY_BULLET.Y_HI);

  if ((m.peek(VAR.DISPLAY_IS_COCKTAIL_P2) & 1) !== 0) {
    // $0AF5: mirrored cabinet -- X is not complemented and the fudge below
    // goes the other way.
    m.poke(spriteAddr + 2, (x - 4) & 0xff);
    m.poke(spriteAddr, ((~yHi) - (b >= 5 ? 1 : 0)) & 0xff);
    return;
  }
  m.poke(spriteAddr + 2, ((~x) - 1) & 0xff);
  // $0AD9: sprite slots 0, 1 and 2 (b = 7, 6, 5) need their Y nudged by one.
  // Scott could not explain it either; it is a hardware artefact.
  m.poke(spriteAddr, ((~yHi) + (b >= 5 ? 1 : 0)) & 0xff);
}

/**
 * TRY_SPAWN_ENEMY_BULLET ($11E0): linear scan for a free slot. If all 14 are
 * busy the shot is silently dropped, which is the game's only real cap on how
 * much fire can be in the air at once.
 *
 * @see reference/galaxian.asm:4472-4489
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} alienSlot index into INFLIGHT_ALIENS of the alien firing
 * @returns {number} the bullet slot used, or -1 if none was free
 */
export function trySpawnEnemyBullet(m, alienSlot) {
  for (let i = 0; i < ENEMY_BULLET.COUNT; i += 1) {
    const addr = BLOCK.ENEMY_BULLETS.addr + i * ENEMY_BULLET.SIZE;
    if ((m.peek(addr + ENEMY_BULLET.IS_ACTIVE) & 1) === 0) {
      spawnEnemyBullet(m, i, alienSlot);
      return i;
    }
  }
  return -1;
}

/**
 * SPAWN_ENEMY_BULLET ($11F0).
 *
 * The bullet starts exactly where the alien is and is aimed at wherever the
 * player is standing *now*, with a deliberate error added (see
 * {@link computeEnemyBulletDelta}). The aim is computed once and never revised.
 *
 * @see reference/galaxian.asm:4498-4521
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} bulletSlot 0-13
 * @param {number} alienSlot index into INFLIGHT_ALIENS
 */
export function spawnEnemyBullet(m, bulletSlot, alienSlot) {
  const addr = BLOCK.ENEMY_BULLETS.addr + bulletSlot * ENEMY_BULLET.SIZE;
  const alien = BLOCK.INFLIGHT_ALIENS.addr + alienSlot * INFLIGHT_ALIEN.SIZE;
  const alienX = m.peek(alien + INFLIGHT_ALIEN.X);
  const alienY = m.peek(alien + INFLIGHT_ALIEN.Y);

  m.poke(addr + ENEMY_BULLET.IS_ACTIVE, 1);
  m.poke(addr + ENEMY_BULLET.X, alienX);
  // $11F7: `ld a,$F0 / sub (hl)` -- how much further down the screen the bullet
  // has to travel to reach the player's row. This is the adjacent side of the
  // aiming triangle. (The listing's comment here says "+16"; it is 240 - X.)
  const adjacent = (0xf0 - alienX) & 0xff;
  m.poke(addr + ENEMY_BULLET.Y_HI, alienY);
  // ENEMY_BULLET.Y_LO is left holding whatever the previous occupant left.

  // $1202: PLAYER_Y - alien.Y decides which way the bullet leans.
  const opposite = (m.peek(VAR.PLAYER_Y) - alienY) & 0xff;
  if (m.peek(VAR.PLAYER_Y) >= alienY) {
    m.poke(addr + ENEMY_BULLET.Y_DELTA, computeEnemyBulletDelta(m, opposite, adjacent));
  } else {
    // $120F: `neg` to get |dY|, compute, then `neg` the answer back.
    const magnitude = computeEnemyBulletDelta(m, (-opposite) & 0xff, adjacent);
    m.poke(addr + ENEMY_BULLET.Y_DELTA, (-magnitude) & 0xff);
  }
}

/**
 * COMPUTE_ENEMY_BULLET_DELTA ($1218).
 *
 * tangent + random(0..31) + 6. The random term is why alien fire is sloppy;
 * the +6 is why even a shot aimed straight down still drifts sideways, which
 * is what makes standing still under a diving alien survivable.
 *
 * CALCULATE_TANGENT is scaled to 128, not 256 -- see src/game/rng.js. Two
 * consequences: the `ret p` "clamp" at $1223 is a bit-7 test on an 8-bit sum,
 * not a real clamp, so a sum that wraps past 255 comes back as a small positive
 * number instead of $7F; and tan(0, d) returns 1 rather than 0.
 *
 * @see reference/galaxian.asm:4524-4531
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} a opposite side: |PLAYER_Y - alien.Y|
 * @param {number} d adjacent side: 240 - alien.X
 * @returns {number} YDelta magnitude, 0-255
 */
export function computeEnemyBulletDelta(m, a, d) {
  const tangent = calculateTangent(a, d);
  const jitter = generateRandomNumber(m) & 0x1f;
  const sum = (jitter + tangent + 6) & 0xff;
  return (sum & 0x80) !== 0 ? 0x7f : sum;
}
