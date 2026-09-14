/**
 * The in-flight alien: the state machine that flies an alien from its cell in
 * the swarm, down past the player, and either back home again or round for
 * another pass.
 *
 * Every alien that is not sitting in the formation lives in one of the eight
 * 32-byte INFLIGHT_ALIEN records at $42B0 and is driven, once per frame, by
 * HANDLE_INFLIGHT_ALIENS ($0CC3). The record's StageOfLife byte indexes one of
 * sixteen "alive" routines, or -- when IsDying is set -- one of four death
 * routines that share the same byte.
 * @see reference/galaxian.asm:3357-3409 (the driver and both dispatch tables)
 *
 * Coordinates follow the rotated monitor, as everywhere else in the port:
 * X is vertical and grows downward, Y is horizontal and grows to the LEFT.
 * @see reference/galaxian.asm:69-85
 *
 * Two mechanisms in here are worth reading before the code:
 *
 *  1. The `inc (ix+$02)` fall-through pairs. Several routines have two adjacent
 *     StageOfLife increments and jump to either the first or the second, so the
 *     same tail advances the state by 2 or by 1 depending on how it was
 *     reached. @see reference/galaxian.asm:3685-3686, 3730-3731, 3957-3958
 *
 *  2. The swing oscillator at $116B, which the disassembly's author explicitly
 *     did not understand (.asm:4346-4350). It is documented at
 *     {@link updateInflightAlienYAdd}; the short version is that record bytes
 *     $19/$1A/$1B/$1C are an 8.8 fixed-point harmonic oscillator, and the
 *     oracle test confirms it traces a cosine.
 */

import { VAR, BLOCK, INFLIGHT_ALIEN, INFLIGHT_SLOT } from '../machine/addresses.js';
import { inflight, setInflight } from '../machine/machine.js';
import { INFLIGHT_ALIEN_ARC_TABLE, ALIEN_COLOUR_SPEED } from './tables.js';
import { generateRandomNumber, calculateTangent } from './rng.js';
import { queueCommand } from './commands.js';

/**
 * Record fields the address map does not name, because the disassembly's struct
 * comment marks them "???" / "Unused" (.asm:614-619). They are the low halves
 * of the swing oscillator's state vector; see {@link updateInflightAlienYAdd}.
 */
export const SWING = {
  /** $1A -- integer part of the swing velocity, signed. */
  VELOCITY: 0x1a,
  /** $1B -- 1/256ths of the swing offset (the fraction under $19). */
  OFFSET_FRACTION: 0x1b,
  /** $1C -- 1/256ths of the swing velocity (the fraction under $1A). */
  VELOCITY_FRACTION: 0x1c,
};

/** INFLIGHT_ALIEN_SPRITE field offsets. @see reference/galaxian.asm:264-270 */
const SPRITE = { Y: 0, CODE: 1, COLOUR: 2, X: 3 };

/**
 * Circular command queue command numbers.
 * @see reference/galaxian.asm:2585-2602
 */
export const COMMAND = {
  DRAW_ALIEN: 0,
  DELETE_ALIEN: 1,
  DISPLAY_PLAYER: 2,
  UPDATE_PLAYER_SCORE: 3,
  RESET_SCORE: 4,
  DISPLAY_SCORE: 5,
  PRINT_TEXT: 6,
  BOTTOM_OF_SCREEN_INFO: 7,
};

/**
 * Hooks for subsystems this module drives but does not own.
 * @typedef {object} InflightHooks
 * @property {(m: import('../machine/machine.js').Machine, slot: number) => void} [trySpawnEnemyBullet]
 *   TRY_SPAWN_ENEMY_BULLET ($11E0), tail-jumped to from states 3 and 9 when a
 *   diving alien lines up on a firing row. Owned by the enemy-bullet module.
 */

/** @type {Required<InflightHooks>} */
const NO_HOOKS = { trySpawnEnemyBullet: () => {} };

/**
 * Fill in any hook the caller left out, without allocating when there is
 * nothing to fill in -- this runs eight times a frame.
 * @param {InflightHooks} hooks
 * @returns {Required<InflightHooks>}
 */
function resolveHooks(hooks) {
  if (hooks.trySpawnEnemyBullet === undefined) return NO_HOOKS;
  return /** @type {Required<InflightHooks>} */ (hooks);
}

// -- small helpers ----------------------------------------------------------

// The command queue itself lives in commands.js; re-exported here because this
// module's call sites read better with it in scope, and so existing imports of
// `queueCommand` from this module keep working.
export { queueCommand } from './commands.js';

/**
 * Read one byte of INFLIGHT_ALIEN_ARC_TABLE, the way the ROM does with
 * `ld h,$1E / ld l,(ix+$13)`.
 *
 * Only offsets 0-93 are reachable in play: an arc is 47 ticks and each tick
 * consumes two bytes. Past $1E67 the ROM would read the GAME START melody,
 * which is not arc data and is not modelled here.
 * @see reference/galaxian.asm:6941-6948
 * @param {number} offset
 * @returns {number}
 */
function arcByte(offset) {
  const value = INFLIGHT_ALIEN_ARC_TABLE[offset];
  if (value === undefined) {
    throw new RangeError(`arc table offset ${offset} is past $1E67`);
  }
  return value;
}

/**
 * Advance StageOfLife by `steps`, the way the `inc (ix+$02)` pairs do.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {number} steps
 */
function advanceStage(m, slot, steps) {
  const stage = inflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE);
  setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, (stage + steps) & 0xff);
}

/**
 * The off-screen test both arc states and both dive states use: a Y that has
 * wrapped round to within 7 pixels of the screen edge.
 * @see reference/galaxian.asm:3505-3507 ($0D8B: add a,$07 / cp $0E)
 * @param {number} y
 * @returns {boolean}
 */
function isOffScreenHorizontally(y) {
  return ((y + 7) & 0xff) < 0x0e;
}

// -- geometry ---------------------------------------------------------------

/**
 * SET_INFLIGHT_ALIEN_START_POSITION ($1147).
 *
 * Turns IndexInSwarm into the pixel position of that swarm cell: rows are 12
 * pixels apart measured up from X = $7C, columns are 16 apart and ride the
 * formation's scroll. Used both when an alien leaves the swarm and, every
 * frame, to steer a returning one back to its slot.
 *
 * @see reference/galaxian.asm:4319-4341
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
export function setInflightAlienStartPosition(m, slot) {
  const index = inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM);

  // $114C-$1152. Two `rrca`s on (index & $70) give row*8 and row*4; their sum
  // is row*12, which is then negated and offset from the bottom row's X.
  const rowBits = index & 0x70;
  const x = (0x7c - ((rowBits >> 1) + (rowBits >> 2))) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.X, x);

  // $1157-$1167. Four `rlca`s multiply the column by 16 (nothing rotates out,
  // the value is masked to a nibble first), then the scroll low byte is added.
  const column = index & 0x0f;
  const y = (m.peek(VAR.SWARM_SCROLL_VALUE) + column * 16 + 7) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.Y, y);
}

/**
 * UPDATE_INFLIGHT_ALIEN_YADD ($116B) -- the swing oscillator.
 *
 * The disassembly gives up on this routine ("I'll be honest, I don't know
 * exactly how it works", .asm:4346-4350) and marks three of its four state
 * bytes as unused. It is in fact a discrete harmonic oscillator in 8.8 fixed
 * point, iterated `(Speed & 3) + 1` times per frame:
 *
 *   offset   h = PivotYValueAdd($19) + SwingOffsetFraction($1B)/256
 *   velocity l = SwingVelocity($1A)  + SwingVelocityFraction($1C)/256
 *
 *   h += 2*l/256      ($117F-$118E, a 16-bit add of the sign-extended 2*L)
 *   l -= 2*h/256      ($118F-$11A0, the same add with the new H negated)
 *
 * That is symplectic Euler on a rotation, so `h` traces a cosine of angular
 * step 1/128 radian per iteration, starting at the amplitude DEFINE_FLIGHTPATH
 * chose and with zero initial velocity -- the swooping curve a diving alien
 * flies. The oracle test drives it for thousands of iterations and confirms
 * both the cosine and the period.
 *
 * Two details are easy to get wrong and both matter:
 *
 *  - the guard at $1189/$119B refuses any update that lands exactly on $80.
 *    $80 is the one byte with no positive counterpart, so letting it through
 *    would flip the swing's sign; the ROM instead restores the previous value,
 *    undoing the `dec h`/`dec l` from the same iteration as well.
 *  - the fraction byte is stored BEFORE that guard can veto the integer byte,
 *    so a vetoed iteration still advances the fraction.
 *
 * @see reference/galaxian.asm:4361-4418
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
export function updateInflightAlienYAdd(m, slot) {
  const iterations = (inflight(m, slot, INFLIGHT_ALIEN.SPEED) & 3) + 1; // $116B-$1171

  let h = inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD);
  let l = inflight(m, slot, SWING.VELOCITY);
  let d = inflight(m, slot, SWING.OFFSET_FRACTION);
  let e = inflight(m, slot, SWING.VELOCITY_FRACTION);

  for (let i = 0; i < iterations; i += 1) {
    // Part 1: H:D += 2*L, with L sign-extended into the high byte.
    const previousH = h;                       // $117F ld c,h
    let a = l;
    let carry = (a >> 7) & 1;                  // $1180 add a,a
    a = (a << 1) & 0xff;
    if (carry) h = (h - 1) & 0xff;             // $1183 dec h -- the sign extension
    let sum = a + d;                           // $1184 add a,d
    d = sum & 0xff;                            // $1185 ld d,a
    carry = sum > 0xff ? 1 : 0;
    a = (h + carry) & 0xff;                    // $1186-$1188 ld a,0 / adc a,h
    if (a === 0x80) a = previousH;             // $1189-$118D the sign guard
    h = a;                                     // $118E

    // Part 2: L:E += 2*(-H), using the H just computed.
    const previousL = l;                       // $118F ld c,l
    a = (-a) & 0xff;                           // $1190 neg
    carry = (a >> 7) & 1;                      // $1192 add a,a
    a = (a << 1) & 0xff;
    if (carry) l = (l - 1) & 0xff;             // $1195 dec l
    sum = a + e;                               // $1196 add a,e
    e = sum & 0xff;                            // $1197 ld e,a
    carry = sum > 0xff ? 1 : 0;
    a = (l + carry) & 0xff;                    // $1198-$119A
    if (a === 0x80) a = previousL;             // $119B-$119F
    l = a;                                     // $11A0
  }

  setInflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD, h);
  setInflight(m, slot, SWING.VELOCITY, l);
  setInflight(m, slot, SWING.OFFSET_FRACTION, d);
  setInflight(m, slot, SWING.VELOCITY_FRACTION, e);
}

/**
 * The $11D0 tail of CALCULATE_INFLIGHT_ALIEN_LOOKAT_ANIM_FRAME: turn a tangent
 * into one of five rotation steps.
 *
 * CALCULATE_TANGENT is scaled to 128, not 256 (see src/game/rng.js), so the
 * clamp at $11D8 caps the ratio at 1.0 rather than 0.5 and the three `rlca`s
 * plus `and $07` reduce to `tangent >> 5`. The result is 0-4, i.e. the alien
 * can face at most 60 degrees off straight-down.
 *
 * @see reference/galaxian.asm:4452-4458
 * @param {number} opposite
 * @param {number} adjacent
 * @returns {number} 0-4
 */
function quantiseLookAtAngle(opposite, adjacent) {
  let tangent = calculateTangent(opposite, adjacent);
  if (tangent & 0x80) tangent = 0x80; // $11D4-$11D8
  return ((tangent << 3) | (tangent >>> 5)) & 0x07; // $11DA-$11DD
}

/**
 * CALCULATE_INFLIGHT_ALIEN_LOOKAT_ANIM_FRAME ($11B0).
 *
 * Points a diving alien's sprite at the player: the tangent of the horizontal
 * offset over the distance still to fall, quantised to a signed rotation step.
 *
 * @see reference/galaxian.asm:4432-4448
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
export function calculateInflightAlienLookAtAnimFrame(m, slot) {
  // $11B0-$11B5: how far above the player's row the alien still is.
  const adjacent = (0xf0 - inflight(m, slot, INFLIGHT_ALIEN.X)) & 0xff;
  const playerY = m.peek(VAR.PLAYER_Y);
  const y = inflight(m, slot, INFLIGHT_ALIEN.Y);
  const offset = (playerY - y) & 0xff;

  if (playerY >= y) {
    setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, quantiseLookAtAngle(offset, adjacent));
    return;
  }
  // $11C5-$11CC: negate going in and coming out, so the frame comes out signed.
  const frame = quantiseLookAtAngle((-offset) & 0xff, adjacent);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, (-frame) & 0xff);
}

// -- shared state tails -----------------------------------------------------

/**
 * The $0DF6 tail of DEFINE_FLIGHTPATH: commit an amplitude, derive the pivot
 * from it so that `Y = pivot + amplitude` still holds, zero the rest of the
 * oscillator state and advance the stage.
 * @see reference/galaxian.asm:3590-3600
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {number} amplitude
 */
function storeFlightpath(m, slot, amplitude) {
  setInflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD, amplitude);
  // $0DF9-$0DFE: `sub (ix+$04) / neg` is Y - amplitude the long way round.
  const pivot = (inflight(m, slot, INFLIGHT_ALIEN.Y) - amplitude) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE, pivot);
  setInflight(m, slot, SWING.VELOCITY, 0);
  setInflight(m, slot, SWING.OFFSET_FRACTION, 0);
  setInflight(m, slot, SWING.VELOCITY_FRACTION, 0);
  advanceStage(m, slot, 1);
}

/**
 * INFLIGHT_ALIEN_DEFINE_FLIGHTPATH ($0DDD).
 *
 * Picks the amplitude of the horizontal swing the alien will fly: half the
 * distance to the player plus 16, clamped to 48-112 pixels and signed towards
 * the player. Because the swing runs from +amplitude through 0 to -amplitude,
 * the alien sweeps twice that distance and crosses the player's column on the
 * way -- a dive from further away is a wider, shallower curve.
 *
 * Called from state 2 (where the increment takes it to 3) and from state 8
 * (where it takes 8 to 9).
 *
 * @see reference/galaxian.asm:3566-3624
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
export function defineFlightpath(m, slot) {
  const playerY = m.peek(VAR.PLAYER_Y);
  const y = inflight(m, slot, INFLIGHT_ALIEN.Y);
  const distance = (y - playerY) & 0xff; // $0DE4 sub b
  let a;

  if (y >= playerY) {
    // No borrow, so the `rra` at $0DE7 shifts a clear carry in: a plain halving.
    a = (distance >> 1) & 0xff;
    a = (a + 0x10) & 0xff;
    if (a < 0x30) a = 0x30; // $0DEA-$0DEE
    if (a >= 0x70) a = 0x70; // $0DF0-$0DF4
  } else {
    // Borrow set, so the `rra` at $0E0F shifts a 1 in: an arithmetic shift that
    // keeps the sign. Both clamps below are UNSIGNED `cp`s in the original and
    // are written out literally here rather than as signed comparisons.
    a = ((distance >> 1) | 0x80) & 0xff;
    a = (a - 0x10) & 0xff;
    if (a >= 0xd0) a = 0xd0; // $0E12-$0E16
    if (a < 0x90) a = 0x90; // $0E18-$0E1C
  }
  storeFlightpath(m, slot, a);
}

/**
 * The $0F7B tail shared by states 8 and 12: give up on looping, pick a fresh
 * flight path and charge at maximum speed for 100 frames.
 * @see reference/galaxian.asm:3949-3953
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function veerErratically(m, slot) {
  defineFlightpath(m, slot); // also advances the stage
  setInflight(m, slot, INFLIGHT_ALIEN.SPEED, 0x03);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x64);
}

/**
 * The shooting test at $0E54, duplicated verbatim at $0FE6.
 *
 * An alien fires when its X equals INFLIGHT_ALIEN_SHOOT_EXACT_X, or that value
 * minus any multiple of 25 pixels up to RANGE_MUL multiples. As the swarm is
 * cleared RANGE_MUL grows, so aliens start firing from further up the screen.
 *
 * @see reference/galaxian.asm:3667-3683
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {Required<InflightHooks>} hooks
 */
function tryShoot(m, slot, hooks) {
  // $0E54 `ld hl,($4213)`: L is the multiplier, H the exact X.
  const exactX = m.peek(VAR.INFLIGHT_ALIEN_SHOOT_EXACT_X);
  let remaining = m.peek(VAR.INFLIGHT_ALIEN_SHOOT_RANGE_MUL);
  let x = inflight(m, slot, INFLIGHT_ALIEN.X);
  // `dec l / jr nz` is a do-while, so a multiplier of 0 means 256 tries.
  do {
    if (x === exactX) { hooks.trySpawnEnemyBullet(m, slot); return; }
    x = (x + 0x19) & 0xff;
    remaining = (remaining - 1) & 0xff;
  } while (remaining !== 0);
}

// -- the sixteen alive states ----------------------------------------------

/**
 * State 0, INFLIGHT_ALIEN_PACKS_BAGS ($0D06). One frame: the alien is lifted
 * out of the formation, given its type's colour and speed, and pointed
 * upside-down ready to peel off.
 * @see reference/galaxian.asm:3421-3474
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienPacksBags(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.SORTIE_COUNT, 0);
  m.poke(VAR.ENABLE_ALIEN_ATTACK_SOUND, 1);
  setInflightAlienStartPosition(m, slot);

  const index = inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM);
  queueCommand(m, COMMAND.DELETE_ALIEN, index);

  // $0D1A-$0D26: (index & $70) >> 3 is row*2, the stride of the colour/speed
  // table at $1DD1.
  const entry = (index & 0x70) >> 3;
  setInflight(m, slot, INFLIGHT_ALIEN.COLOUR, ALIEN_COLOUR_SPEED[entry]);
  setInflight(m, slot, INFLIGHT_ALIEN.SPEED, ALIEN_COLOUR_SPEED[entry + 1]);

  if (entry === 0x0e) {
    // Flagship. Its escorts are the two records that follow it, which is what
    // `(ix+$20)` and `(ix+$40)` address. @see reference/galaxian.asm:3465-3473
    setInflight(m, slot, INFLIGHT_ALIEN.ANIM_FRAME_START_CODE, 0x18);
    let escorts = 0;
    if (inflight(m, slot + 1, INFLIGHT_ALIEN.IS_ACTIVE) & 1) escorts += 1;
    if (inflight(m, slot + 2, INFLIGHT_ALIEN.IS_ACTIVE) & 1) escorts += 1;
    m.poke(VAR.FLAGSHIP_ESCORT_COUNT, escorts);
  } else {
    setInflight(m, slot, INFLIGHT_ALIEN.ANIM_FRAME_START_CODE, 0x00);
  }

  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x03);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, 0x0c);
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB, 0x00);
  advanceStage(m, slot, 1);

  // +/-12 steps of 15 degrees is 180 degrees: hanging upside down in the swarm.
  const clockwise = inflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE) & 1;
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, clockwise ? 0xf4 : 0x0c);
}

/**
 * State 1, INFLIGHT_ALIEN_FLIES_IN_ARC ($0D71), and state 11, which jumps
 * straight here.
 *
 * Walks the half-circle trace at $1E00 one (dx, dy) pair per frame while
 * rotating the sprite 12 steps -- 3 frames before the first step and 4 between
 * the rest, so 47 ticks and 180 degrees. From state 1 the tail lands on state
 * 2; from state 11 it lands on state 12.
 *
 * @see reference/galaxian.asm:3489-3548
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienFliesInArc(m, slot) {
  let offset = inflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB);

  const x = (inflight(m, slot, INFLIGHT_ALIEN.X) + arcByte(offset)) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.X, x);
  offset = (offset + 1) & 0xff;

  const clockwise = inflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE) & 1;
  const dy = arcByte(offset);
  const previousY = inflight(m, slot, INFLIGHT_ALIEN.Y);
  const y = (clockwise ? previousY - dy : previousY + dy) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.Y, y);

  // $0DCC: shoved off the side mid-peel, so skip straight to the re-entry state.
  if (isOffScreenHorizontally(y)) {
    setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0x05);
    return;
  }
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB, (offset + 1) & 0xff);

  const delay = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, delay);
  if (delay !== 0) return;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x04);

  const frame = inflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, (clockwise ? frame + 1 : frame - 1) & 0xff);

  const stepsLeft = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, stepsLeft);
  if (stepsLeft !== 0) return;
  advanceStage(m, slot, 1);
}

/**
 * State 2, INFLIGHT_ALIEN_READY_TO_ATTACK ($0DD1). One frame: choose the dive.
 *
 * A red alien flying while the flagship in slot 1 is airborne copies the
 * flagship's amplitude instead of computing its own, which is what makes an
 * escort hold formation -- same swing, own pivot, so the spacing is preserved.
 *
 * @see reference/galaxian.asm:3559-3564, 3617-3624
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienReadyToAttack(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.X, (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff);

  const isRed = (inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM) & 0x70) === 0x60;
  if (isRed && (inflight(m, INFLIGHT_SLOT.FLAGSHIP, INFLIGHT_ALIEN.IS_ACTIVE) & 1)) {
    storeFlightpath(m, slot, inflight(m, INFLIGHT_SLOT.FLAGSHIP, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD));
    return;
  }
  defineFlightpath(m, slot);
}

/**
 * State 3, INFLIGHT_ALIEN_ATTACKING_PLAYER ($0E2B). The main dive: one pixel
 * down per frame with the swing supplying the horizontal motion, facing the
 * player and firing when it lines up.
 * @see reference/galaxian.asm:3636-3687
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {Required<InflightHooks>} hooks
 */
function inflightAlienAttackingPlayer(m, slot, hooks) {
  setInflight(m, slot, INFLIGHT_ALIEN.X, (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff);
  updateInflightAlienYAdd(m, slot);

  const y = (inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE)
    + inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD)) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.Y, y);

  // $0E3E enters the increment pair at the first inc, so +2, straight to
  // state 5; $0E45 enters at the second, so +1, to state 4.
  if (isOffScreenHorizontally(y)) { advanceStage(m, slot, 2); return; }
  const x = inflight(m, slot, INFLIGHT_ALIEN.X);
  if (x + 0x48 > 0xff) { advanceStage(m, slot, 1); return; } // X >= $B8

  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  calculateInflightAlienLookAtAnimFrame(m, slot);
  if (m.peek(VAR.IS_FLAGSHIP_HIT) & 1) return; // shocked swarm holds its fire
  tryShoot(m, slot, hooks);
}

/**
 * State 4, INFLIGHT_ALIEN_NEAR_BOTTOM_OF_SCREEN ($0E6B). Speeds up to 1.5
 * pixels a frame for the fly-past and drops out as soon as the alien leaves
 * the bottom or either side.
 * @see reference/galaxian.asm:3697-3723
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienNearBottomOfScreen(m, slot) {
  const step = (m.peek(VAR.TIMING_VARIABLE) & 1) + 1; // 1 or 2 px, alternating
  const x = (inflight(m, slot, INFLIGHT_ALIEN.X) + step) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.X, x);

  // $0E77: X has wrapped past the bottom of the screen and back to 6-8.
  if (((x - 6) & 0xff) < 3) { advanceStage(m, slot, 1); return; }

  updateInflightAlienYAdd(m, slot);

  // $0E80-$0E93: `pivot + amplitude` done so that the carry tells us whether a
  // signed sum has left the screen -- a positive amplitude must not carry, a
  // negative one must.
  const amplitude = inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD);
  const sum = amplitude + inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE);
  const carry = sum > 0xff;
  if ((amplitude & 0x80) ? !carry : carry) { advanceStage(m, slot, 1); return; }
  setInflight(m, slot, INFLIGHT_ALIEN.Y, sum & 0xff);
}

/**
 * The $0EAD tail of state 5: decide whether the alien rejoins the formation or
 * comes round for another pass.
 * @see reference/galaxian.asm:3763-3788
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function decideWhetherToReattack(m, slot) {
  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) { advanceStage(m, slot, 1); return; }

  // Aliens only refuse to go home once the swarm is nearly dead, or once the
  // blue and purple rows are gone entirely.
  if (m.peek(VAR.HAVE_AGGRESSIVE_ALIENS) === 0
    && m.peek(VAR.HAVE_NO_BLUE_OR_PURPLE_ALIENS) === 0) {
    advanceStage(m, slot, 1);
    return;
  }

  // $0EBF-$0ECC: come back in somewhere unpredictable so the player cannot
  // simply park under the alien's old column and wait.
  const y = inflight(m, slot, INFLIGHT_ALIEN.Y);
  const reentry = ((y >> 1) + (generateRandomNumber(m) & 0x1f) + 0x20) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.Y, reentry);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x28);
  advanceStage(m, slot, 2);
}

/**
 * State 5, INFLIGHT_ALIEN_REACHED_BOTTOM_OF_SCREEN ($0E99). One frame:
 * teleport to the top of the play area and pick what happens next.
 *
 * A flagship with no surviving escort escapes the wave instead, and is carried
 * into the next one (at most two are).
 *
 * @see reference/galaxian.asm:3747-3831
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienReachedBottomOfScreen(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.X, 0x08);
  const sorties = (inflight(m, slot, INFLIGHT_ALIEN.SORTIE_COUNT) + 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.SORTIE_COUNT, sorties);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, 0x00);

  if ((inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM) & 0x70) === 0x70) {
    if (m.peek(VAR.FLAGSHIP_ESCORT_COUNT) === 0) {
      // $0EE0: unescorted, so it flees the level entirely.
      setInflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE, 0);
      let survivors = (m.peek(VAR.FLAGSHIP_SURVIVOR_COUNT) + 1) & 0xff;
      if (survivors >= 3) survivors = 2; // $0EE8-$0EEC
      m.poke(VAR.FLAGSHIP_SURVIVOR_COUNT, survivors);
      return;
    }
    // $0EF2 COUNT_FLAGSHIP_ESCORTS: recount before going round again.
    let escorts = 0;
    if (inflight(m, slot + 1, INFLIGHT_ALIEN.IS_ACTIVE) & 1) escorts += 1;
    if (inflight(m, slot + 2, INFLIGHT_ALIEN.IS_ACTIVE) & 1) escorts += 1;
    m.poke(VAR.FLAGSHIP_ESCORT_COUNT, escorts);
  }

  decideWhetherToReattack(m, slot);
}

/**
 * INFLIGHT_ALIEN_BACK_IN_SWARM ($0F2B): the alien has landed back in its cell.
 * @see reference/galaxian.asm:3869-3876
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function backInSwarm(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE, 0);
  const index = inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM);
  m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + index, 1);
  queueCommand(m, COMMAND.DRAW_ALIEN, index);
}

/**
 * State 6, INFLIGHT_ALIEN_RETURNING_TO_SWARM ($0F07).
 *
 * Descends one pixel a frame from the top of the screen. Y is recomputed from
 * the home cell every frame and deliberately NOT restored -- only X is -- which
 * is what locks a returning alien to its column and makes it track the
 * formation's scroll on the way down. Over the last 24 pixels it rotates 12
 * steps so it arrives upside-down like its neighbours.
 *
 * @see reference/galaxian.asm:3842-3866
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienReturningToSwarm(m, slot) {
  const descended = (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff;
  setInflightAlienStartPosition(m, slot);
  const homeX = inflight(m, slot, INFLIGHT_ALIEN.X);
  setInflight(m, slot, INFLIGHT_ALIEN.X, descended);

  const distance = (homeX - descended) & 0xff;
  if (distance === 0) { backInSwarm(m, slot); return; }
  if (distance >= 0x19) return; // still more than 25px out: just keep falling
  if (distance & 1) return; // rotate on even distances only, so 12 steps in 24px

  const frame = inflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME);
  const clockwise = inflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE) & 1;
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, (clockwise ? frame - 1 : frame + 1) & 0xff);
}

/**
 * State 7, INFLIGHT_ALIEN_CONTINUING_ATTACK_RUN_FROM_TOP_OF_SCREEN ($0F3C).
 *
 * 40 frames of silent homing descent. PivotYValue is reused as the fractional
 * low byte of a 16-bit Y, and each frame subtracts a 64th of the distance to
 * the player -- exponential homing with no shooting.
 *
 * @see reference/galaxian.asm:3891-3915
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienContinuingAttackRun(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.X, (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff);

  const y = inflight(m, slot, INFLIGHT_ALIEN.Y);
  // $0F3F-$0F4D builds DE = 4 * (Y - PLAYER_Y) as a signed 16-bit value. It is
  // written out instruction by instruction because `neg` sets the carry that
  // the following `rla` shifts in, and `sbc a,a` then smears that carry into
  // the high byte.
  const difference = (y - m.peek(VAR.PLAYER_Y)) & 0xff;
  let carry = difference !== 0 ? 1 : 0; // $0F45 neg
  const low = ((difference << 1) | carry) & 0xff; // $0F47 rla
  carry = (difference >> 7) & 1;
  const high = carry ? 0xff : 0x00; // $0F49 sbc a,a, carry untouched
  const lowTimesTwo = ((low << 1) | carry) & 0xff; // $0F4B rl e
  const highTimesTwo = ((high << 1) | ((low >> 7) & 1)) & 0xff; // $0F4D rl d

  const position = ((y << 8) | inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE)) & 0xffff;
  const moved = (position - ((highTimesTwo << 8) | lowTimesTwo)) & 0xffff; // $0F56 sbc hl,de
  setInflight(m, slot, INFLIGHT_ALIEN.Y, moved >> 8);
  setInflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE, moved & 0xff);

  const remaining = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, remaining);
  if (remaining !== 0) return;
  advanceStage(m, slot, 1);
}

/**
 * State 8, INFLIGHT_ALIEN_FULL_SPEED_CHARGE ($0F66).
 *
 * If the alien is in the middle 64x64 pixels of the screen there is room for a
 * loop-the-loop, curled towards the player; otherwise it picks a new flight
 * path and charges.
 * @see reference/galaxian.asm:3929-3966
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienFullSpeedCharge(m, slot) {
  const x = (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.X, x);

  const y = inflight(m, slot, INFLIGHT_ALIEN.Y);
  const roomToLoop = ((x - 0x60) & 0xff) < 0x40 && ((y - 0x60) & 0xff) < 0x40;
  if (!roomToLoop) { veerErratically(m, slot); return; }

  advanceStage(m, slot, 2); // $0F87 + $0F8A, both incs run
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x03);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, 0x0c);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, 0x00);
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB, 0x00);
  // $0F9D: loop towards the player -- carry from PLAYER_Y - Y means the player
  // is to the alien's right.
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE, m.peek(VAR.PLAYER_Y) < y ? 1 : 0);
}

/**
 * State 9, INFLIGHT_ALIEN_ATTACKING_PLAYER_AGGRESSIVELY ($0FAF).
 *
 * Like state 3, but after four passes the alien starts dragging its pivot one
 * pixel a frame onto the player's column -- every other frame on the fourth
 * sortie, every frame from the fifth. After 100 frames it drops back to state 8
 * and looks for another loop.
 *
 * @see reference/galaxian.asm:3976-4043
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {Required<InflightHooks>} hooks
 */
function inflightAlienAttackingPlayerAggressively(m, slot, hooks) {
  setInflight(m, slot, INFLIGHT_ALIEN.X, (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff);
  updateInflightAlienYAdd(m, slot);

  const sorties = inflight(m, slot, INFLIGHT_ALIEN.SORTIE_COUNT);
  const hug = sorties > 4
    || (sorties === 4 && (m.peek(VAR.TIMING_VARIABLE) & 1) !== 0);
  if (hug) {
    // $100B: creep the pivot towards the player rather than the alien itself,
    // so the swing shape is kept but recentred.
    const pivot = inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE);
    const closer = m.peek(VAR.PLAYER_Y) >= pivot ? pivot + 1 : pivot - 1;
    setInflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE, closer & 0xff);
  }

  const y = (inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE)
    + inflight(m, slot, INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD)) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.Y, y);

  if (isOffScreenHorizontally(y)) {
    setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0x05);
    return;
  }
  // $0FD0: X >= $C0, i.e. 8 pixels lower than state 3's threshold.
  if (inflight(m, slot, INFLIGHT_ALIEN.X) + 0x40 > 0xff) {
    setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0x04);
    return;
  }

  const remaining = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, remaining);
  if (remaining === 0) { advanceStage(m, slot, -1); return; } // $1000 dec, back to 8

  if ((m.peek(VAR.HAS_PLAYER_SPAWNED) & 1) === 0) return;
  calculateInflightAlienLookAtAnimFrame(m, slot);
  if (m.peek(VAR.IS_FLAGSHIP_HIT) & 1) return;
  tryShoot(m, slot, hooks);
}

/**
 * State 10, INFLIGHT_ALIEN_LOOP_THE_LOOP ($101F).
 *
 * The same arc table as state 1 but with the X delta subtracted and the Y
 * delta's sign swapped: the mirrored half-circle. 270 degrees of rotation here,
 * the remaining 90 in state 11, so the pair stitches into a full 32-pixel loop.
 * Note there is deliberately no off-screen test in this state.
 *
 * @see reference/galaxian.asm:4056-4118
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienLoopTheLoop(m, slot) {
  let offset = inflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB);

  const x = (inflight(m, slot, INFLIGHT_ALIEN.X) - arcByte(offset)) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.X, x);
  offset = (offset + 1) & 0xff;

  const clockwise = inflight(m, slot, INFLIGHT_ALIEN.ARC_CLOCKWISE) & 1;
  const dy = arcByte(offset);
  const previousY = inflight(m, slot, INFLIGHT_ALIEN.Y);
  setInflight(m, slot, INFLIGHT_ALIEN.Y, (clockwise ? previousY + dy : previousY - dy) & 0xff);
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB, (offset + 1) & 0xff);

  const delay = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, delay);
  if (delay !== 0) return;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x04);

  const frame = inflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, (clockwise ? frame + 1 : frame - 1) & 0xff);

  const stepsLeft = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, stepsLeft);
  if (stepsLeft !== 0) return;

  advanceStage(m, slot, 1);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x03);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, 0x0c);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME, clockwise ? 0xf4 : 0x0c);
  setInflight(m, slot, INFLIGHT_ALIEN.ARC_TABLE_LSB, 0x00);
}

/**
 * State 12, INFLIGHT_ALIEN_UNKNOWN_1091 ($1091). Reachable only by state 11
 * finishing its 47 ticks; it resets the stage to 8 and then falls into the
 * "veer erratically" tail, whose own increment lands on 9.
 * @see reference/galaxian.asm:4125-4128
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function inflightAlienLoopComplete(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.X, (inflight(m, slot, INFLIGHT_ALIEN.X) + 1) & 0xff);
  setInflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE, 0x08);
  veerErratically(m, slot);
}

/**
 * State 13, CONVOY_CHARGER_SET_COLOUR_POS_ANIM ($109B). Attract mode only: lay
 * out the four example aliens on the WE ARE THE GALAXIANS page.
 * @see reference/galaxian.asm:4141-4168
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function convoyChargerSetColourPosAnim(m, slot) {
  // $109E: the index is 0 blue .. 3 flagship, complemented to 0 flagship .. 3 blue.
  const type = (~inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM)) & 0x03;
  const colour = (type + 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.COLOUR, colour);
  // $10A6-$10AC: the four `rlca`s act on the COLOUR just written, not on the
  // type -- so the rows are 16 pixels apart starting one row below $8C.
  setInflight(m, slot, INFLIGHT_ALIEN.X, (colour * 16 + 0x8c) & 0xff);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x18);
  advanceStage(m, slot, 1);
  setInflight(m, slot, INFLIGHT_ALIEN.ANIM_FRAME_START_CODE, type === 0 ? 0x18 : 0x00);
}

/**
 * State 14, CONVOY_CHARGER_START_SCROLL ($10C2). Slides the sprite on for 24
 * frames, then asks for its points caption.
 * @see reference/galaxian.asm:4177-4190
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function convoyChargerStartScroll(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.Y, (inflight(m, slot, INFLIGHT_ALIEN.Y) + 1) & 0xff);
  const remaining = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, remaining);
  if (remaining !== 0) return;

  const index = inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM);
  queueCommand(m, COMMAND.PRINT_TEXT, (index + 0x4b) & 0xff);
  advanceStage(m, slot, 1);
}

/**
 * State 15, CONVOY_CHARGER_DO_SCROLL ($10D8). Keeps sliding until the sprite
 * reaches its parking spot.
 * @see reference/galaxian.asm:4199-4213
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function convoyChargerDoScroll(m, slot) {
  const y = inflight(m, slot, INFLIGHT_ALIEN.Y);
  if (((y - 0xc8) & 0xff) < 5) return;
  setInflight(m, slot, INFLIGHT_ALIEN.Y, (y + 1) & 0xff);
}

/**
 * The jump table at $0CE6.
 * @see reference/galaxian.asm:3387-3405
 * @type {ReadonlyArray<(m: import('../machine/machine.js').Machine, slot: number, hooks: Required<InflightHooks>) => void>}
 */
const ALIVE_STATES = Object.freeze([
  inflightAlienPacksBags,
  inflightAlienFliesInArc,
  inflightAlienReadyToAttack,
  inflightAlienAttackingPlayer,
  inflightAlienNearBottomOfScreen,
  inflightAlienReachedBottomOfScreen,
  inflightAlienReturningToSwarm,
  inflightAlienContinuingAttackRun,
  inflightAlienFullSpeedCharge,
  inflightAlienAttackingPlayerAggressively,
  inflightAlienLoopTheLoop,
  inflightAlienFliesInArc, // state 11 is `jp $0D71`
  inflightAlienLoopComplete,
  convoyChargerSetColourPosAnim,
  convoyChargerStartScroll,
  convoyChargerDoScroll,
]);

// -- the dying machine ------------------------------------------------------

/**
 * Dying state 0, INFLIGHT_ALIEN_DYING_SETUP_ANIM_AND_SOUND ($10F0).
 * @see reference/galaxian.asm:4238-4253
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function dyingSetupAnimAndSound(m, slot) {
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x04);
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, 0x04);
  setInflight(m, slot, INFLIGHT_ALIEN.DEATH_ANIM_CODE, 0x1c);
  advanceStage(m, slot, 1);
  // $1102 compares the whole IndexInSwarm, not just its row nibble.
  const isFlagship = inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM) >= 0x70;
  m.poke(VAR.ALIEN_DEATH_SOUND, isFlagship ? 0x17 : 0x07);
}

/**
 * Dying state 1, INFLIGHT_ALIEN_DYING_DISPLAY_EXPLOSION ($1112). Four frames of
 * explosion, one every four ticks; a flagship then shows its score instead of
 * freeing the record.
 * @see reference/galaxian.asm:4263-4288
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function dyingDisplayExplosion(m, slot) {
  const delay = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, delay);
  if (delay !== 0) return;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x04);

  const code = (inflight(m, slot, INFLIGHT_ALIEN.DEATH_ANIM_CODE) + 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.DEATH_ANIM_CODE, code);

  const framesLeft = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_2, framesLeft);
  if (framesLeft !== 0) return;

  if (inflight(m, slot, INFLIGHT_ALIEN.INDEX_IN_SWARM) < 0x70) {
    setInflight(m, slot, INFLIGHT_ALIEN.IS_DYING, 0); // record is free again
    return;
  }
  // $112D DISPLAY_FLAGSHIP_POINTS_VALUE
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, 0x32);
  setInflight(m, slot, INFLIGHT_ALIEN.DEATH_ANIM_CODE,
    (m.peek(VAR.FLAGSHIP_SCORE_FACTOR) + 0x20) & 0xff);
  advanceStage(m, slot, 1);
}

/**
 * Dying state 2, INFLIGHT_ALIEN_DYING_FINALLY_BUYS_FARM ($113D). Holds the
 * flagship's score on screen for 50 frames, then frees the record.
 * @see reference/galaxian.asm:4295-4299
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 */
function dyingFinallyBuysFarm(m, slot) {
  const remaining = (inflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1) - 1) & 0xff;
  setInflight(m, slot, INFLIGHT_ALIEN.TEMP_COUNTER_1, remaining);
  if (remaining !== 0) return;
  setInflight(m, slot, INFLIGHT_ALIEN.IS_DYING, 0);
}

/**
 * The jump table at $10E8. Entry 3 is a bare `ret`.
 * @see reference/galaxian.asm:4224-4229
 * @type {ReadonlyArray<(m: import('../machine/machine.js').Machine, slot: number) => void>}
 */
const DYING_STATES = Object.freeze([
  dyingSetupAnimAndSound,
  dyingDisplayExplosion,
  dyingFinallyBuysFarm,
  () => {},
]);

// -- drivers ----------------------------------------------------------------

/**
 * HANDLE_INFLIGHT_ALIEN_STAGE_OF_LIFE ($0CD6).
 *
 * IsDying takes priority over IsActive and dispatches through a different
 * table, but both read the same StageOfLife byte.
 *
 * @see reference/galaxian.asm:3381-3409, 4221-4229
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot 0-7
 * @param {InflightHooks} [hooks]
 */
export function handleInflightAlienStageOfLife(m, slot, hooks = NO_HOOKS) {
  const stage = inflight(m, slot, INFLIGHT_ALIEN.STAGE_OF_LIFE);

  if (inflight(m, slot, INFLIGHT_ALIEN.IS_DYING) & 1) {
    const dying = DYING_STATES[stage];
    if (dying === undefined) throw new RangeError(`dying stage ${stage} has no handler`);
    dying(m, slot);
    return;
  }
  if ((inflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE) & 1) === 0) return;

  const alive = ALIVE_STATES[stage];
  if (alive === undefined) throw new RangeError(`stage of life ${stage} has no handler`);
  alive(m, slot, resolveHooks(hooks));
}

/**
 * HANDLE_INFLIGHT_ALIENS ($0CC3): run the state machine for all eight records.
 *
 * Slot 0 is the shared explosion scratch used when a swarm alien is shot in
 * place, so it is normally inactive; slots 1-3 are the flagship and its two
 * escorts and 4-7 the lone attackers, which caps the screen at seven aliens.
 *
 * @see reference/galaxian.asm:3357-3366, 576-583
 * @param {import('../machine/machine.js').Machine} m
 * @param {InflightHooks} [hooks]
 */
export function handleInflightAliens(m, hooks = NO_HOOKS) {
  const resolved = resolveHooks(hooks);
  for (let slot = 0; slot < INFLIGHT_ALIEN.COUNT; slot += 1) {
    handleInflightAlienStageOfLife(m, slot, resolved);
  }
}

// -- sprite projection ------------------------------------------------------

/**
 * SET_INACTIVE_OR_DYING_SPRITE_STATE ($0C98). A dying alien is drawn white with
 * its explosion code; a finished one is parked off-screen.
 * @see reference/galaxian.asm:3329-3349
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {number} spriteAddr
 * @param {number} yAdjust
 */
export function setInactiveOrDyingSpriteState(m, slot, spriteAddr, yAdjust) {
  if ((inflight(m, slot, INFLIGHT_ALIEN.IS_DYING) & 1) === 0) {
    m.poke(spriteAddr + SPRITE.X, 0xf8);
    m.poke(spriteAddr + SPRITE.Y, 0xf8);
    return;
  }
  m.poke(spriteAddr + SPRITE.COLOUR, 0x07); // white
  m.poke(spriteAddr + SPRITE.X, (inflight(m, slot, INFLIGHT_ALIEN.X) - 8) & 0xff);
  m.poke(spriteAddr + SPRITE.Y, (~inflight(m, slot, INFLIGHT_ALIEN.Y) - yAdjust) & 0xff);
  m.poke(spriteAddr + SPRITE.CODE, inflight(m, slot, INFLIGHT_ALIEN.DEATH_ANIM_CODE));
}

/**
 * SET_SPRITE_STATE ($0C20): project one INFLIGHT_ALIEN into one sprite.
 *
 * AnimationFrame is a signed rotation in 24 steps of 15 degrees, 0 being
 * nose-down at the player and +/-12 upside-down in the swarm. Only a quarter
 * turn of artwork exists ($11-$17); the other three quadrants are made with the
 * sprite hardware's X and Y flip bits, which is why each quadrant has its own
 * arithmetic and its own one-pixel position nudge.
 *
 * The `sub $18` / `add $18` re-dispatches at $0C90/$0C94 fold any frame back
 * into range, so the rotation wraps mod 24.
 *
 * @see reference/galaxian.asm:3246-3318
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} slot
 * @param {number} spriteAddr address of the 4-byte INFLIGHT_ALIEN_SPRITE
 * @param {number} yAdjust the C register: 7, 8 or 9 depending on the slot
 */
export function setSpriteState(m, slot, spriteAddr, yAdjust) {
  if ((inflight(m, slot, INFLIGHT_ALIEN.IS_ACTIVE) & 1) === 0) {
    setInactiveOrDyingSpriteState(m, slot, spriteAddr, yAdjust);
    return;
  }
  m.poke(spriteAddr + SPRITE.COLOUR, inflight(m, slot, INFLIGHT_ALIEN.COLOUR));

  let x = (inflight(m, slot, INFLIGHT_ALIEN.X) - 8) & 0xff;
  let y = (~inflight(m, slot, INFLIGHT_ALIEN.Y) - yAdjust) & 0xff;

  let a = inflight(m, slot, INFLIGHT_ALIEN.ANIMATION_FRAME);
  let code = 0;
  // The branches below are `cp n` followed by `jp p`/`jp m`, which test bit 7
  // of the difference rather than performing a true signed comparison. They are
  // written out that way deliberately.
  for (;;) {
    if ((a & 0x80) === 0) { // $0C41 jp p
      if ((((a - 0x06) & 0xff) & 0x80) === 0) { // $0C5A jp p
        if ((((a - 0x0c) & 0xff) & 0x80) === 0) { // $0C70 jp p
          a = (a - 0x18) & 0xff; // $0C90, re-dispatch
          continue;
        }
        // 6..11: 270-360 degrees, Y-flipped
        code = ((((~a) & 0xff) + 0x1e) & 0xff) | 0x80; // $0C73-$0C76
        y = (y + 1) & 0xff;
        break;
      }
      // 0..5: 180-270 degrees, both flips
      code = ((a + 0x11) & 0xff) | 0xc0; // $0C5D-$0C5F
      x = (x + 1) & 0xff;
      y = (y + 1) & 0xff;
      break;
    }
    if ((((a - 0xfa) & 0xff) & 0x80) !== 0) { // $0C46 jp m
      if ((((a - 0xf4) & 0xff) & 0x80) !== 0) { // $0C84 jp m
        a = (a + 0x18) & 0xff; // $0C94, re-dispatch
        continue;
      }
      // -12..-7: 0-90 degrees, unflipped
      code = (a + 0x1d) & 0xff; // $0C87
      break;
    }
    // -6..-1: 90-180 degrees, X-flipped
    code = ((((~a) & 0xff) + 0x12) & 0xff) | 0x40; // $0C49-$0C4C
    x = (x + 1) & 0xff;
    break;
  }

  // $00 for an alien, $18 for a flagship. Added after the flip bits are OR'd
  // in, which is safe because every tile number stays below $2F.
  code = (code + inflight(m, slot, INFLIGHT_ALIEN.ANIM_FRAME_START_CODE)) & 0xff;

  m.poke(spriteAddr + SPRITE.CODE, code);
  m.poke(spriteAddr + SPRITE.X, x);
  m.poke(spriteAddr + SPRITE.Y, y);
}

/**
 * HANDLE_INFLIGHT_ALIEN_SPRITE_UPDATE ($0BBE): fill the eight sprite slots of
 * the OBJRAM back buffer from the eight alien records.
 *
 * The first three sprites take a Y adjustment of 7 and the last five 8 (9 then
 * 8 with the screen flipped for player two in a cocktail cabinet) -- a hardware
 * quirk of how the sprite generator lines objects up.
 *
 * @see reference/galaxian.asm:3185-3212
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleInflightAlienSpriteUpdate(m) {
  const cocktailP2 = (m.peek(VAR.DISPLAY_IS_COCKTAIL_P2) & 1) !== 0;
  let yAdjust = cocktailP2 ? 9 : 7;
  const sprites = BLOCK.OBJRAM_BACK_BUF_SPRITES.addr;

  for (let slot = 0; slot < INFLIGHT_ALIEN.COUNT; slot += 1) {
    if (slot === 3) yAdjust += cocktailP2 ? -1 : 1;
    setSpriteState(m, slot, sprites + slot * 4, yAdjust);
  }
}
