/**
 * The Galaxian starfield.
 *
 * The stars are not data -- there is no star table in the ROM. They come from a
 * free-running 17-bit shift register on the video board, and the "pattern" is
 * simply which states of that register happen to satisfy a match condition.
 * Reproducing the register reproduces the exact star layout of the original.
 *
 * Two details are easy to get wrong:
 *
 *  - Galaxian's stars do NOT twinkle. The blink circuit exists only on
 *    Scramble-class boards. They scroll and nothing else.
 *  - The register is clocked 512 times per scanline but its period is
 *    2^17 - 1, one short of 512 * 256. That one-clock slip per frame is what
 *    makes the field drift, at half a pixel per frame.
 *
 * @see docs/video-sound.md part B.3 (derived from MAME's galaxian_v.cpp)
 */

import { STAR_LEVELS } from './palette.js';

/** 2^17 - 1. The all-ones state is the illegal one, so 0 is a valid seed. */
export const STAR_RNG_PERIOD = (1 << 17) - 1;

/** RNG clocks per scanline: two per 6 MHz pixel across 256 pixels. */
const CLOCKS_PER_LINE = 512;

/**
 * One byte per register state: bit 7 set if a star is present here, low 6 bits
 * give its colour index.
 * @type {Uint8Array}
 */
export const STAR_TABLE = buildStarTable();

/** @returns {Uint8Array} */
function buildStarTable() {
  const table = new Uint8Array(STAR_RNG_PERIOD);
  let shift = 0;
  for (let i = 0; i < STAR_RNG_PERIOD; i += 1) {
    // A star exists where the top eight bits are all set and bit 0 is clear,
    // which happens roughly once every 512 clocks.
    const present = (shift & 0x1fe01) === 0x1fe00;
    const colour = (~shift & 0x1f8) >>> 3;
    table[i] = colour | (present ? 0x80 : 0);
    // Feedback is bit 12 XNOR bit 0, shifted into bit 16.
    const feedback = ((shift >>> 12) ^ ~shift) & 1;
    shift = (shift >>> 1) | (feedback << 16);
  }
  return table;
}

/**
 * The 64 star colours as packed RGBA, ready to drop into an ImageData buffer.
 * Each channel is driven by two resistors, so it takes one of four levels.
 * @type {Uint32Array}
 */
export const STAR_RGBA = buildStarColours();

/** @returns {Uint32Array} */
function buildStarColours() {
  const colours = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) {
    const r = STAR_LEVELS[(((i >> 4) & 1) << 1) | ((i >> 5) & 1)];
    const g = STAR_LEVELS[(((i >> 2) & 1) << 1) | ((i >> 3) & 1)];
    const b = STAR_LEVELS[(((i >> 0) & 1) << 1) | ((i >> 1) & 1)];
    // Little-endian RGBA, which is what a Uint32 view of ImageData expects.
    colours[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return colours;
}

export class Starfield {
  /** Position of the shift register at the top of the current frame. */
  origin = 0;

  /**
   * Advance one frame. The register slips exactly one clock per frame, and one
   * clock is half a pixel, so the field drifts at 0.5 px per frame.
   * @param {boolean} flipped true in cocktail mode, which reverses the drift
   */
  step(flipped = false) {
    const delta = flipped ? 1 : STAR_RNG_PERIOD - 1;
    this.origin = (this.origin + delta) % STAR_RNG_PERIOD;
  }

  /**
   * Draw the starfield into a 224x256 screen buffer.
   *
   * Iterates in raster space, because that is where the geometry is simple,
   * converting each point to screen coordinates as it goes. The cabinet is
   * rotated 90 degrees, so raster Y becomes screen X and raster X becomes
   * screen Y.
   *
   * @param {Uint32Array} out 224*256 pixels, RGBA
   * @param {number} width screen width, 224
   */
  render(out, width) {
    const table = STAR_TABLE;
    const colours = STAR_RGBA;
    for (let rasterY = 16; rasterY <= 239; rasterY += 1) {
      const screenX = 239 - rasterY;
      let offset = (this.origin + rasterY * CLOCKS_PER_LINE) % STAR_RNG_PERIOD;
      for (let rasterX = 0; rasterX < 256; rasterX += 1) {
        // The checkerboard gate halves the star density and gives the field its
        // dithered look: stars only appear where V0 differs from H3.
        const gated = ((rasterY ^ (rasterX >> 3)) & 1) !== 0;
        // Two register clocks per pixel. The first covers a third of a pixel and
        // the second two thirds, so at 1x we take the second.
        offset += 1; if (offset >= STAR_RNG_PERIOD) offset = 0;
        offset += 1; if (offset >= STAR_RNG_PERIOD) offset = 0;
        const star = table[offset];
        if (gated && (star & 0x80) !== 0) {
          out[rasterX * width + screenX] = colours[star & 0x3f];
        }
      }
    }
  }
}
