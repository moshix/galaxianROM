/**
 * Character plotting primitives.
 *
 * These are the four little helpers every drawing routine in the ROM funnels
 * through. Their names come from the disassembly and describe the *memory*
 * layout, which is transposed from what the player sees: the monitor is rotated
 * 90 degrees, so "same row" in memory means a vertical pair on screen and
 * "same column" means a horizontal pair.
 *
 * @see reference/galaxian.asm:8256-8336
 */

/** Blank character used by the 2x2 plotters. @see reference/galaxian.asm:8283 */
export const BLANK_2X2 = 0x2c;
/** Blank used by the descending plotter. @see reference/galaxian.asm:8281 */
export const BLANK_2X2_DESCENDING = 0x2e;
/** The ordinary space character. @see reference/galaxian.asm:864 */
export const BLANK = 0x10;

/**
 * Write one character.
 *
 * This goes through the machine's full address decode rather than indexing
 * character RAM directly, because several ROM routines compute their target by
 * arithmetic that can walk clean out of the character RAM window -- see the
 * runaway loop in DISPLAY_PLAYER_SHIPS_REMAINING. On the real board those
 * strays land in working RAM or hit ROM and are discarded, and the decode here
 * reproduces that. Masking to character RAM instead would silently wrap them
 * back on screen.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr absolute address, normally $5000-$53FF
 * @param {number} value
 */
function put(m, addr, value) {
  m.write(addr & 0xffff, value);
}

/**
 * PLOT_CHARACTERS_2_BY_2_ASCENDING ($2585). Screen layout:
 *
 *     base+2 | base+0
 *     base+3 | base+1
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} base first character ordinal
 * @param {number} addr character RAM address of the first character
 */
export function plot2x2Ascending(m, base, addr) {
  put(m, addr, base);
  put(m, addr + 1, base + 1);
  put(m, addr + 32, base + 2);
  put(m, addr + 33, base + 3);
}

/**
 * PLOT_CHARACTERS_2_BY_2_DESCENDING ($2591). The mirror image, which leaves the
 * cursor two columns further along; used for the row of spare-ship icons.
 *
 *     base-2 | base-1
 *     base+0 | base+1
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} base
 * @param {number} addr
 */
export function plot2x2Descending(m, base, addr) {
  put(m, addr, base);
  put(m, addr + 1, base + 1);
  put(m, addr - 32, base - 2);
  put(m, addr - 31, base - 1);
}

/**
 * PLOT_TWO_CHARACTERS_IN_SAME_COLUMN ($25A9). Two characters side by side on
 * screen, `base` on the right and `base+2` on the left. This is how the 1x2
 * swarm aliens are drawn.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} base
 * @param {number} addr
 */
export function plotPairAcross(m, base, addr) {
  put(m, addr, base);
  put(m, addr + 32, base + 2);
}

/**
 * CONVERT_A_TO_BCD ($2569). Binary 0-99 to packed BCD.
 * @see reference/galaxian.asm:8212-8250
 * @param {number} value
 * @returns {number}
 */
export function toBcd(value) {
  const v = value & 0xff;
  return (((Math.floor(v / 10) % 10) << 4) | (v % 10)) & 0xff;
}

export { put as putChar };
