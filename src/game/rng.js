/**
 * The two small maths helpers the whole game is built on.
 * @see reference/galaxian.asm:733-761
 */

import { VAR } from '../machine/addresses.js';

/**
 * GENERATE_RANDOM_NUMBER ($003C).
 *
 * A linear congruential generator, `r = r*5 + 1 (mod 256)`, done on the Z80 as
 * `add a,a / add a,a / add a,b / inc a`. Period is 256 and it visits every byte
 * value, so it is really a shuffled counter rather than a random source -- which
 * is why alien attack patterns in Galaxian feel varied but never truly random.
 *
 * Seeded from whatever RAND_NUMBER happens to hold; the power-on RAM test
 * leaves it deterministic, so a given input sequence always replays identically.
 * That determinism is what makes lock-step comparison against the oracle
 * possible at all.
 *
 * @see reference/galaxian.asm:733-741
 * @param {import('../machine/machine.js').Machine} m
 * @returns {number} the new value, 0-255
 */
export function generateRandomNumber(m) {
  const next = (m.peek(VAR.RAND_NUMBER) * 5 + 1) & 0xff;
  m.poke(VAR.RAND_NUMBER, next);
  return next;
}

/**
 * CALCULATE_TANGENT ($0048).
 *
 * Eight steps of restoring division producing roughly `128 * a / d` -- the
 * tangent of the angle whose opposite side is `a` and adjacent side is `d`.
 *
 * Note the scale: **128, not 256.** The first quotient bit comes from comparing
 * `a` against `d` itself, and after eight `rl c` shifts that bit carries weight
 * 128, so `a == d` yields 128 rather than 255. Both written specs originally
 * claimed 256; the ROM settled it (test/oracle/subroutines.test.mjs).
 *
 * It also runs slightly high. `rr d` truncates the divisor toward zero every
 * step, so each threshold is a little smaller than `d / 2^k` and bits get set
 * more readily; once the divisor reaches 0 every remaining comparison succeeds
 * and the low bits fill with ones. That is why `calculateTangent(0, d)` returns
 * a small non-zero value for small `d`. Both effects are in the original and
 * are load-bearing: they shape enemy bullet aim and alien facing frames.
 *
 * Used to aim enemy bullets at the player and to pick which of the 24 rotation
 * frames a diving alien should be drawn in.
 *
 * The Z80 does this with `cp d / sub d / ccf / rl c / rr d`. The `ccf` is what
 * makes the quotient bit come out the right way round: carry is *set* when the
 * subtraction did not borrow.
 *
 * @see reference/galaxian.asm:751-761
 * @param {number} a opposite side, 0-255
 * @param {number} d adjacent side, 0-255
 * @returns {number} tangent in 1/256 units, 0-255
 */
export function calculateTangent(a, d) {
  let numerator = a & 0xff;
  let divisor = d & 0xff;
  let quotient = 0;
  for (let step = 0; step < 8; step += 1) {
    let bit = 0;
    if (numerator >= divisor) { numerator = (numerator - divisor) & 0xff; bit = 1; }
    quotient = ((quotient << 1) | bit) & 0xff;
    divisor >>= 1;
  }
  return quotient;
}

/**
 * Reinterpret a byte as a signed 8-bit value, which the Z80 does implicitly
 * whenever a value is used as a displacement or a delta.
 * @param {number} b
 * @returns {number} -128..127
 */
export function int8(b) {
  const v = b & 0xff;
  return v > 127 ? v - 256 : v;
}
