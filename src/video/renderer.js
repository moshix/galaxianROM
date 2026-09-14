/**
 * Turns the board's video memory into pixels, the same way the hardware does.
 *
 * The renderer reads only character RAM and OBJRAM, so it does not care whether
 * those were filled in by the JavaScript port or by the Z80 oracle running the
 * original ROM. That is deliberate: it lets us render the real 1979 game through
 * this code and compare.
 *
 * COORDINATES. The cabinet is rotated 90 degrees, so nothing lines up with
 * intuition. In raster space the visible area is 256 wide by 224 tall; on the
 * player's screen that is 224 wide by 256 tall, via:
 *
 *     screenX = 239 - rasterY        rasterY in [16, 239]
 *     screenY = rasterX              rasterX in [0, 255]
 *
 * A consequence worth internalising: the low five bits of a character RAM
 * address select the SCREEN ROW, and the per-column scroll registers move
 * screen rows HORIZONTALLY. The disassembly's own header note gets this
 * slightly wrong; see docs/video-sound.md part 0.
 *
 * @see docs/video-sound.md
 */

import { PALETTE, SHELL_COLOUR, MISSILE_COLOUR } from './palette.js';
import { TILE_PIXELS } from './tiles.js';
import { SPRITE_PIXELS } from './sprites.js';
import { Starfield } from './starfield.js';

export const SCREEN_WIDTH = 224;
export const SCREEN_HEIGHT = 256;

/** Raster lines outside this range are in vertical blanking. */
const RASTER_TOP = 16;
const RASTER_BOTTOM = 239;

/** Sprite code bits. @see reference/galaxian.asm:264-270 */
const CODE_MASK = 0x3f;
const ROM_X_FLIP = 0x40;
const ROM_Y_FLIP = 0x80;

/** @param {readonly [number, number, number]} rgb @returns {number} packed RGBA */
const rgba = (rgb) => (255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];

/** Palette as packed RGBA, indexed by colour*4 + pen. Pen 0 is transparent. */
const PALETTE_RGBA = new Uint32Array(PALETTE.map(rgba));
const SHELL_RGBA = rgba(/** @type {[number,number,number]} */ (SHELL_COLOUR));
const MISSILE_RGBA = rgba(/** @type {[number,number,number]} */ (MISSILE_COLOUR));

export class Renderer {
  /** 224 x 256 packed RGBA, ready for putImageData. */
  pixels = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  starfield = new Starfield();

  /**
   * Render one frame.
   * @param {Uint8Array} charRam 1 KB, $5000-$53FF
   * @param {Uint8Array} objRam 256 bytes, $5800-$58FF
   * @param {{stars?: boolean, flipX?: boolean, flipY?: boolean}} [video] latch state
   */
  render(charRam, objRam, video = {}) {
    this.pixels.fill(0xff000000); // opaque black
    if (video.stars !== false) this.starfield.render(this.pixels, SCREEN_WIDTH);
    this.drawTilemap(charRam, objRam);
    this.drawSprites(objRam);
    this.drawBullets(objRam);
  }

  /** Advance the starfield by one frame. @param {boolean} [flipped] */
  stepStars(flipped = false) { this.starfield.step(flipped); }

  /**
   * The 32x32 character layer.
   *
   * Each tilemap column gets its own scroll value, and because a tilemap column
   * is a screen row, that scroll slides the row sideways. This is how both the
   * alien formation and the player's ship move horizontally -- neither is a
   * sprite.
   *
   * @param {Uint8Array} charRam
   * @param {Uint8Array} objRam
   */
  drawTilemap(charRam, objRam) {
    const out = this.pixels;
    for (let col = 0; col < 32; col += 1) {
      const scroll = objRam[col * 2];
      const colourBase = (objRam[col * 2 + 1] & 7) * 4;
      const screenY = col * 8;
      if (screenY >= SCREEN_HEIGHT) continue;

      for (let row = 0; row < 32; row += 1) {
        const code = charRam[row * 32 + col];
        const tileBase = code * 64;
        // Raster Y of this tile's first line, after its column's scroll.
        const rasterTop = (row * 8 - scroll) & 0xff;

        for (let tx = 0; tx < 8; tx += 1) {
          // Screen X increases as raster Y decreases, so the tile's leftmost
          // pixel is its last raster line. Wrapping here is what makes a tile
          // straddling raster line 0 appear correctly at both screen edges.
          const rasterY = (rasterTop + 7 - tx) & 0xff;
          if (rasterY < RASTER_TOP || rasterY > RASTER_BOTTOM) continue;
          const screenX = 239 - rasterY;

          for (let ty = 0; ty < 8; ty += 1) {
            const pen = TILE_PIXELS[tileBase + ty * 8 + tx];
            if (pen === 0) continue; // pen 0 is transparent, as on the hardware
            const y = screenY + ty;
            if (y >= SCREEN_HEIGHT) break;
            out[y * SCREEN_WIDTH + screenX] = PALETTE_RGBA[colourBase + pen];
          }
        }
      }
    }
  }

  /**
   * The eight hardware sprites.
   *
   * Drawn from 7 down to 0 because the hardware's line buffer only accepts a
   * write into a still-empty slot, so the LOWEST numbered sprite wins. Slot 0
   * is the shared explosion scratch, slot 1 the flagship, 2 and 3 its escorts.
   *
   * @param {Uint8Array} objRam
   */
  drawSprites(objRam) {
    const out = this.pixels;
    for (let n = 7; n >= 0; n -= 1) {
      const base = 0x40 + n * 4;
      const hpos = objRam[base];
      const code = objRam[base + 1];
      const colourBase = (objRam[base + 2] & 7) * 4;
      const vpos = objRam[base + 3];

      // The first three sprites match against one scanline earlier than the
      // rest -- a genuine hardware quirk that the game compensates for when it
      // writes these bytes. @see docs/video-sound.md section 0.4
      const screenXBase = hpos - (n < 3 ? 15 : 16);
      const screenYBase = vpos + 1;
      if (screenYBase >= SCREEN_HEIGHT || screenYBase + 16 <= 0) continue;

      // The bitmaps are stored pre-rotated, so the ROM's X flip is a vertical
      // flip on screen and its Y flip is a horizontal one.
      const flipScreenY = (code & ROM_X_FLIP) !== 0;
      const flipScreenX = (code & ROM_Y_FLIP) !== 0;
      const spriteBase = (code & CODE_MASK) * 256;

      for (let sy = 0; sy < 16; sy += 1) {
        const y = screenYBase + sy;
        if (y < 0 || y >= SCREEN_HEIGHT) continue;
        const srcY = flipScreenY ? 15 - sy : sy;
        for (let sx = 0; sx < 16; sx += 1) {
          const x = screenXBase + sx;
          if (x < 0 || x >= SCREEN_WIDTH) continue;
          const srcX = flipScreenX ? 15 - sx : sx;
          const pen = SPRITE_PIXELS[spriteBase + srcY * 16 + srcX];
          if (pen === 0) continue;
          out[y * SCREEN_WIDTH + x] = PALETTE_RGBA[colourBase + pen];
        }
      }
    }
  }

  /**
   * Shells and missiles.
   *
   * These bypass the palette entirely: the hardware ORs them into the RGB
   * output after the colour lookup, which is why they are brighter than any
   * tile. Objects 0-6 are the aliens' white shells; object 7 is the player's
   * yellow missile. Each is one pixel wide and four tall on screen.
   *
   * @param {Uint8Array} objRam
   */
  drawBullets(objRam) {
    const out = this.pixels;
    for (let n = 0; n < 8; n += 1) {
      const base = 0x60 + n * 4;
      const horizontal = objRam[base + 1];
      const vertical = objRam[base + 3];

      // Byte +1 selects the scanline: the comparator fires where
      // (byte + V) & 0xFF == 0xFF, so the raster line is 255 - byte. Lines
      // outside the visible window are simply never reached, which is how an
      // inactive bullet parked at 0 is culled.
      const rasterY = (255 - horizontal) & 0xff;
      if (rasterY < RASTER_TOP || rasterY > RASTER_BOTTOM) continue;
      const screenX = 239 - rasterY;

      // Byte +3 preloads a horizontal DOWN counter, so a larger byte means a
      // position further UP the rotated screen, and the four pixel streak
      // extends upwards from 254 - byte. Getting this backwards sends shots
      // away from the ship instead of towards the aliens.
      const bottom = (254 - vertical) & 0xff;
      const colour = n === 7 ? MISSILE_RGBA : SHELL_RGBA;

      for (let i = 0; i < 4; i += 1) {
        const y = bottom - i;
        if (y < 0 || y >= SCREEN_HEIGHT) continue;
        out[y * SCREEN_WIDTH + screenX] = colour;
      }
    }
  }
}
