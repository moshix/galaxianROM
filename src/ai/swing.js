/**
 * The diving alien's sideways swing, predicted forward.
 *
 * A dive is two independent motions. Vertically the alien advances exactly one
 * pixel a frame, which needs no prediction at all. Horizontally it sits at
 * `PIVOT_Y_VALUE + PIVOT_Y_VALUE_ADD`, where the second term is driven by a
 * little oscillator the ROM runs in 8.8 fixed point -- symplectic Euler on a
 * rotation, so it traces a cosine of angular step 1/128 radian per iteration.
 *
 * That makes the whole arc computable from six bytes the AI can read, which is
 * the single most valuable thing it can know: where a diver will be when it
 * arrives, rather than where it is now.
 *
 * WHY THIS IS A TRANSCRIPTION AND NOT `A * cos(wt)`. Two details make the
 * closed form wrong by a pixel or two over a few hundred iterations, and a
 * pixel or two is the entire safety margin:
 *
 *  - the velocity update negates the *truncated* integer byte and ignores its
 *    fraction, so the recurrence is not exactly the analytic rotation;
 *  - the guard at $1189/$119B refuses any update landing on $80 -- the one byte
 *    with no positive counterpart -- and restores the previous value instead.
 *    That is a cliff, not a drift, if it ever fires.
 *
 * So this is a line-for-line copy of `updateInflightAlienYAdd` operating on
 * plain numbers instead of a `Machine`, and `test/unit/ai-swing.test.mjs`
 * drives both for thousands of iterations and requires them to agree byte for
 * byte. That test is the only thing standing between this file and a silent
 * divergence from the game it is predicting.
 *
 * @see src/game/inflight.js `updateInflightAlienYAdd`
 * @see reference/galaxian.asm:4361-4418
 */

/**
 * The oscillator's state, in the ROM's own register names: H:D is the offset in
 * 8.8 fixed point, L:E the velocity.
 * @typedef {object} Swing
 * @property {number} h PIVOT_Y_VALUE_ADD ($19), the integer offset
 * @property {number} l SWING.VELOCITY ($1a), signed
 * @property {number} d SWING.OFFSET_FRACTION ($1b)
 * @property {number} e SWING.VELOCITY_FRACTION ($1c)
 */

/**
 * One frame of the swing, mutating `s` in place.
 *
 * In place and allocation-free on purpose: this runs tens of thousands of times
 * a second across every diver on screen, and a fresh object per iteration would
 * cost more than the arithmetic.
 *
 * @param {Swing} s
 * @param {number} iterations `(SPEED & 3) + 1`
 * @returns {void}
 */
export function stepSwing(s, iterations) {
  let { h, l, d, e } = s;

  for (let i = 0; i < iterations; i += 1) {
    // Part 1: H:D += 2*L, with L sign-extended into the high byte.
    const previousH = h;
    let a = l;
    let carry = (a >> 7) & 1;
    a = (a << 1) & 0xff;
    if (carry) h = (h - 1) & 0xff;
    let sum = a + d;
    d = sum & 0xff;
    carry = sum > 0xff ? 1 : 0;
    a = (h + carry) & 0xff;
    if (a === 0x80) a = previousH;
    h = a;

    // Part 2: L:E += 2*(-H), using the H just computed.
    const previousL = l;
    a = (-a) & 0xff;
    carry = (a >> 7) & 1;
    a = (a << 1) & 0xff;
    if (carry) l = (l - 1) & 0xff;
    sum = a + e;
    e = sum & 0xff;
    carry = sum > 0xff ? 1 : 0;
    a = (l + carry) & 0xff;
    if (a === 0x80) a = previousL;
    l = a;
  }

  s.h = h;
  s.l = l;
  s.d = d;
  s.e = e;
}

/** Reinterpret a byte as signed, which is how the ROM uses H and L. */
const signed = (b) => ((b & 0xff) > 127 ? (b & 0xff) - 256 : (b & 0xff));

/**
 * How far the swing can possibly travel, for all time.
 *
 * The update is a rotation, so `h^2 + l^2` is very nearly conserved and
 * `hypot(h, l)` bounds `|h|` for every future iteration to within a fraction of
 * a percent. One pixel of slack covers the rest.
 *
 * This exists purely to reject divers cheaply: if the interval the alien could
 * ever occupy does not reach the ship, there is no point iterating its arc at
 * all, and most divers on screen fall out here for nothing.
 *
 * @param {Swing} s
 * @returns {number} an upper bound on |h| that is never exceeded
 */
export function swingAmplitude(s) {
  return Math.hypot(signed(s.h), signed(s.l)) + 1;
}

/**
 * Read a swing out of an alien's record fields.
 * @param {number} pivotAdd @param {number} velocity
 * @param {number} offsetFraction @param {number} velocityFraction
 * @returns {Swing}
 */
export function makeSwing(pivotAdd, velocity, offsetFraction, velocityFraction) {
  return { h: pivotAdd & 0xff, l: velocity & 0xff, d: offsetFraction & 0xff, e: velocityFraction & 0xff };
}

/** The signed pixel offset the swing currently represents. @param {Swing} s */
export function swingOffset(s) {
  return signed(s.h);
}
