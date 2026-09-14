/**
 * Where a threat will be, frame by frame.
 *
 * The AI's old model was "a bullet drifts, a diver is a box where it is now".
 * The second half of that is the expensive mistake: a diving alien crosses tens
 * of pixels sideways on its way down, so its current position says almost
 * nothing about where it will be when it arrives. Everything here exists to
 * replace that guess with arithmetic.
 *
 * THE FRAME INDEX. `mainGameLogic` runs move, then the player's bullet, then
 * enemy bullets, then divers, then the collision tests -- and `nmi` decrements
 * TIMING_VARIABLE before any of it. So on frame *k* counted from now: the ship
 * has made exactly k moves, every enemy bullet has taken k steps of two, every
 * diver has taken k steps of its own, and the timing value the game sees is
 * `(T0 - k) & 0xff` where T0 is what the AI read this frame. One index for
 * everything, and every prediction below is written in it.
 *
 * Both predictors fill a caller-owned {@link ThreatWindow} rather than
 * allocating, because this runs for every bullet and every alien on screen,
 * sixty times a second, in a browser that is also emulating an arcade board.
 *
 * @see src/game/bullets.js `handleEnemyBullets`
 * @see src/game/inflight.js `inflightAlienAttackingPlayer`
 */

import { stepSwing, swingAmplitude, makeSwing } from './swing.js';
import {
  PLAYER_X, BULLET_LETHAL_FIRST_X, BULLET_LETHAL_LAST_X, BULLET_HALF,
  DIVER_LETHAL_FIRST_X, DIVER_LETHAL_LAST_X, DIVER_HALF,
  BULLET_FALL_PER_FRAME, DIVE_HANDOFF_X, DIVE_HANDOFF_X_AGGRESSIVE,
  STAGE_ATTACKING, STAGE_NEAR_BOTTOM, STAGE_AGGRESSIVE,
  HUG_GROWTH, HUG_GROWTH_CAP, Y_MIN, Y_MAX,
} from './constants.js';

/**
 * A span of frames during which one thing can kill the ship, and where it will
 * be for each of them.
 *
 * @typedef {object} ThreatWindow
 * @property {number} kind 0 enemy bullet, 1 in-flight alien
 * @property {number} slot record index, so the shot chooser can name it
 * @property {number} first first frame it can kill, at least 1
 * @property {number} last last frame it can kill
 * @property {Int16Array} track centre Y per frame, indexed `[f - first]`
 * @property {number} half lethal half-width including margin
 * @property {number} halfGrow extra half-width per frame, for pursuit
 * @property {number} yMin lowest centre over the window, for a quick reject
 * @property {number} yMax highest centre over the window
 */

/** Longest window either kind of threat can produce, for preallocation. */
const MAX_WINDOW = 64;

/** @returns {ThreatWindow} */
export function makeThreatWindow() {
  return {
    kind: 0, slot: 0, first: 0, last: -1,
    track: new Int16Array(MAX_WINDOW),
    half: 0, halfGrow: 0, yMin: 0, yMax: 0,
  };
}

/** `((y + 7) & 0xff) < 0x0e`, the ROM's off-the-side test. @param {number} y */
function offScreenHorizontally(y) {
  return ((y + 7) & 0xff) < 0x0e;
}

/** Fill in the envelope fields once the track is written. @param {ThreatWindow} w */
function summarise(w) {
  let lo = 0x7fff;
  let hi = -0x8000;
  for (let f = w.first; f <= w.last; f += 1) {
    const y = w.track[f - w.first];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  w.yMin = lo;
  w.yMax = hi;
}

/**
 * Predict one enemy bullet. Closed form, no loop, and bit-exact.
 *
 * Vertically a bullet descends exactly two pixels every frame without
 * exception -- both halves of the multiplex move it -- so the lethal window is
 * pure arithmetic. Laterally it only steps on the frames the multiplexer picks
 * it: `handleEnemyBullets` starts on bullet 0 when TIMING is odd and bullet 1
 * when it is even, and walks two records at a time, so bullet *i* gets its full
 * update on frame k exactly when `(i & 1) !== ((T0 - k) & 1)`. Counting those
 * frames is the only subtlety, and it collapses to a ceil or a floor.
 *
 * Working in the full 8.8 pair rather than the pixel byte is what makes this
 * exact; the old code threw the fraction away and inherited up to a pixel of
 * error before it even multiplied by the flight time.
 *
 * @param {{slot: number, x: number, yLo: number, yHi: number, delta: number}} b
 *   `delta` already sign-extended to -128..127
 * @param {number} timing TIMING_VARIABLE as read this frame
 * @param {number} horizon
 * @param {ThreatWindow} out
 * @returns {boolean} false if this bullet can never reach the ship
 */
export function predictBullet(b, timing, horizon, out) {
  const first = Math.max(1, Math.ceil((BULLET_LETHAL_FIRST_X - b.x) / BULLET_FALL_PER_FRAME));
  const last = Math.floor((BULLET_LETHAL_LAST_X - b.x) / BULLET_FALL_PER_FRAME);
  if (last < first || first > horizon) return false;

  const start = (b.yLo | (b.yHi << 8)) & 0xffff;
  const step = (2 * b.delta) & 0xffff;
  // Which parity of frame this record is updated on. `(T0 - i) & 1` even means
  // the odd frames, which is a ceil; odd means the even frames, a floor.
  const onOddFrames = (((timing - b.slot) & 1) === 0);

  const stop = Math.min(last, horizon);
  for (let f = first; f <= stop; f += 1) {
    const updates = onOddFrames ? Math.ceil(f / 2) : Math.floor(f / 2);
    const pos = (start + updates * step) & 0xffff;
    const yHi = (pos >> 8) & 0xff;
    // The 32-wide dead band around the screen edges: the bullet is deleted
    // before it would wrap, so it never arrives.
    if (((yHi + 0x10) & 0xff) < 0x20) {
      if (f === first) return false;
      out.last = f - 1;
      out.kind = 0;
      out.slot = b.slot;
      out.first = first;
      out.half = BULLET_HALF;
      out.halfGrow = 0;
      summarise(out);
      return true;
    }
    out.track[f - first] = yHi;
  }

  out.kind = 0;
  out.slot = b.slot;
  out.first = first;
  out.last = stop;
  out.half = BULLET_HALF;
  out.halfGrow = 0;
  summarise(out);
  return true;
}

/**
 * Predict one in-flight alien.
 *
 * Only three of the sixteen states can reach the ship inside the horizon, and
 * that is provable rather than hopeful: state 5 teleports back to the top of
 * the screen, state 7 runs forty frames from X=8, states 10 and 11 are ninety
 * frames of loop confined to the middle of the screen. Everything else is far
 * enough away that it can be answered later.
 *
 * The one thing that cannot be skipped is the **hand-off**. The dive proper
 * bails out at X = $B8, which is still 35 pixels above the ship, so a predictor
 * that models state 3 alone predicts an alien that never arrives. State 4 keeps
 * running the same oscillator against the same pivot and only changes the
 * vertical rate, so one continuous iteration covers both.
 *
 * @param {object} d sampled record fields
 * @param {number} d.slot @param {number} d.stage @param {number} d.x
 * @param {number} d.pivot @param {number} d.pivotAdd @param {number} d.speed
 * @param {number} d.swingL @param {number} d.swingD @param {number} d.swingE
 * @param {number} d.sorties
 * @param {number} timing TIMING_VARIABLE as read this frame
 * @param {number} playerY
 * @param {number} horizon
 * @param {ThreatWindow} out
 * @returns {boolean} false if it cannot reach the ship in time
 */
export function predictDiver(d, timing, playerY, horizon, out) {
  let stage = d.stage;
  if (stage !== STAGE_ATTACKING && stage !== STAGE_NEAR_BOTTOM && stage !== STAGE_AGGRESSIVE) {
    return false;
  }

  const swing = makeSwing(d.pivotAdd, d.swingL, d.swingD, d.swingE);

  // Cheap rejection before a single iteration: the oscillator is a rotation, so
  // its amplitude bounds the alien's sideways reach for all time. If the strip
  // it could ever occupy does not meet the strip the ship could ever occupy,
  // there is nothing to compute. Most divers on screen die here.
  const reach = swingAmplitude(swing);
  const lo = d.pivot - reach - DIVER_HALF;
  const hi = d.pivot + reach + DIVER_HALF;
  if (hi < Y_MIN || lo > Y_MAX) return false;

  const iterations = (d.speed & 3) + 1;
  const handoff = stage === STAGE_AGGRESSIVE ? DIVE_HANDOFF_X_AGGRESSIVE : DIVE_HANDOFF_X;
  // A state-9 alien past its fourth sortie drags its pivot toward the ship.
  const hugs = stage === STAGE_AGGRESSIVE && d.sorties >= 4;

  let x = d.x;
  let pivot = d.pivot;
  let first = -1;
  let last = -1;

  for (let f = 1; f <= horizon; f += 1) {
    if (stage === STAGE_ATTACKING || stage === STAGE_AGGRESSIVE) {
      x = (x + 1) & 0xff;
      if (hugs) pivot = (pivot + Math.sign(playerY - pivot)) & 0xff;
      stepSwing(swing, iterations);
      const y = (pivot + swing.h) & 0xff;
      if (offScreenHorizontally(y)) break;
      if (x >= handoff) stage = STAGE_NEAR_BOTTOM;
      if (x >= DIVER_LETHAL_FIRST_X && x <= DIVER_LETHAL_LAST_X) {
        if (first < 0) first = f;
        last = f;
        out.track[f - first] = y;
      }
    } else {
      const step = ((timing - f) & 1) + 1;
      x = (x + step) & 0xff;
      if (((x - 6) & 0xff) < 3) break;     // wrapped off the bottom
      stepSwing(swing, iterations);
      const sum = swing.h + pivot;
      const carry = sum > 0xff;
      if ((swing.h & 0x80) ? !carry : carry) break;  // left the side
      const y = sum & 0xff;
      if (x >= DIVER_LETHAL_FIRST_X && x <= DIVER_LETHAL_LAST_X) {
        if (first < 0) first = f;
        last = f;
        out.track[f - first] = y;
      }
    }
    if (first >= 0 && x > DIVER_LETHAL_LAST_X) break;
  }

  if (first < 0) return false;

  out.kind = 1;
  out.slot = d.slot;
  out.first = first;
  out.last = last;
  out.half = DIVER_HALF;
  out.halfGrow = hugs ? HUG_GROWTH : 0;
  summarise(out);
  return true;
}

/** The cap on a pursuing threat's widening band. */
export const HUG_CAP = HUG_GROWTH_CAP;

/** Where the ship is, for callers that want the lethal row. */
export const SHIP_X = PLAYER_X;
