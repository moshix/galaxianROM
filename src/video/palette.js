/**
 * GENERATED FILE -- do not edit by hand.
 * Run `node tools/gen-graphics.mjs` to regenerate.
 *
 * Decoded from reference/galaxian_gfx.c, which comes from Jean-Francois Fabre's
 * open-source Galaxian port (https://github.com/jotd666/galaxian500). The
 * original artwork is Namco's, from the 1979 board's graphics ROMs; this is a
 * faithful recreation for a homage project, not new art.
 *
 * Pixels are 2 bits (0 = transparent, 1-3 = palette pens), packed four per byte
 * and base64 encoded. Bitmaps are already in screen orientation.
 */

/**
 * The 32-entry colour table: 8 colour codes of 4 pens each, resolved from the
 * board's 6L colour PROM through its resistor ladder (220/470/1k on red and
 * green, 220/470 on blue -- which is why blue has only two bits of depth).
 *
 * Pen 0 is always black and is treated as transparent, exactly as the hardware
 * does. Colour codes in use: 1 flagship, 2 red alien, 3 purple alien, 4 blue
 * alien, 5 red text, 6 player ship, 7 explosions, 0 white text.
 *
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const PALETTE = Object.freeze([
  [  0,   0,   0], // colour 0 pen 0
  [  0,   0,   0], // colour 0 pen 1
  [  0,   0,   0], // colour 0 pen 2
  [222, 222, 247], // colour 0 pen 3
  [  0,   0,   0], // colour 1 pen 0
  [222,  71,   0], // colour 1 pen 1
  [  0,   0, 247], // colour 1 pen 2
  [255, 255,   0], // colour 1 pen 3
  [  0,   0,   0], // colour 2 pen 0
  [  0, 104, 247], // colour 2 pen 1
  [255,   0,   0], // colour 2 pen 2
  [255, 255,   0], // colour 2 pen 3
  [  0,   0,   0], // colour 3 pen 0
  [  0,   0, 247], // colour 3 pen 1
  [151,   0, 247], // colour 3 pen 2
  [255,   0,   0], // colour 3 pen 3
  [  0,   0,   0], // colour 4 pen 0
  [  0,   0, 247], // colour 4 pen 1
  [  0, 151, 168], // colour 4 pen 2
  [255,   0,   0], // colour 4 pen 3
  [  0,   0,   0], // colour 5 pen 0
  [  0,   0,   0], // colour 5 pen 1
  [  0,   0,   0], // colour 5 pen 2
  [255,   0,   0], // colour 5 pen 3
  [  0,   0,   0], // colour 6 pen 0
  [222, 222, 247], // colour 6 pen 1
  [255,   0,   0], // colour 6 pen 2
  [  0, 222, 247], // colour 6 pen 3
  [  0,   0,   0], // colour 7 pen 0
  [222, 222,  79], // colour 7 pen 1
  [255,   0,   0], // colour 7 pen 2
  [222,   0, 247], // colour 7 pen 3
].map((c) => Object.freeze(c)));

/**
 * Bullets bypass the palette entirely -- the hardware ORs them straight into
 * the RGB output, which is why they are brighter than any tile colour.
 * Objects 0-6 are alien shells; object 7 is the player's missile.
 */
export const SHELL_COLOUR = Object.freeze([239, 239, 239]);
export const MISSILE_COLOUR = Object.freeze([239, 239, 0]);

/**
 * Star brightness levels. Each channel is driven by two resistors (150R and
 * 100R) tapping the same node, giving four levels per channel and 64 colours.
 * Stars sum into the output after the palette, so they are brighter than tiles.
 */
export const STAR_LEVELS = Object.freeze([0, 194, 214, 255]);
