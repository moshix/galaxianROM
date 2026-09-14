/**
 * Screen text.
 *
 * PRINT_TEXT takes a string index plus two flag bits, and can draw a string,
 * erase it, or set it up to scroll in one character at a time. The strings
 * themselves live in src/game/tables.js, extracted from the ROM rather than
 * transcribed.
 *
 * The character ordinal for a source byte is simply `byte - $30`, which is why
 * the strings look like ASCII with '@' for space (`$40 - $30 = $10`, the blank
 * character) and '?' as the terminator (`$3F - $30 = $0F`).
 *
 * Text runs left to right on screen by stepping the character RAM pointer
 * *backwards* 32 bytes at a time, because the monitor is rotated.
 *
 * @see reference/galaxian.asm:7889-7999 (PRINT_TEXT)
 * @see reference/galaxian.asm:5993-6026 (HANDLE_TEXT_SCROLL)
 */

import { VAR } from '../machine/addresses.js';
import { TEXTS } from './tables.js';
import { putChar } from './plot.js';

/** Terminator, as it appears in the source bytes. */
const TERMINATOR = 0x3f;
/** Blank written by the erase path; note it is $40, not the usual $10. */
const ERASE_CHAR = 0x40;
/** Character RAM step between successive characters: 32 back. */
const STEP = -32;

/** Flags packed into the PRINT_TEXT parameter. */
export const TEXT_SCROLL_ON = 0x40;
export const TEXT_ERASE = 0x80;

/**
 * PRINT_TEXT ($22F1).
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} code string index, optionally with TEXT_SCROLL_ON or TEXT_ERASE
 */
export function printText(m, code) {
  const value = code & 0xff;
  // The ROM doubles the index and masks to six bits before using it, so an
  // index above 31 wraps rather than running off the end of the table.
  const index = ((value * 2) & 0x3f) >> 1;
  const entry = TEXTS[index];
  if (entry === undefined) return;

  // `add a,a` leaves the original bit 7 in carry (erase) and the original
  // bit 6 in sign (scroll), which is what the two branches test.
  if ((value & TEXT_ERASE) !== 0) { eraseText(m, entry); return; }
  if ((value & TEXT_SCROLL_ON) !== 0) { beginColumnScroll(m, entry); return; }

  let addr = entry.charAddr;
  for (const byte of entry.bytes) {
    if (byte === TERMINATOR) return;
    putChar(m, addr, (byte - 0x30) & 0xff);
    addr += STEP;
  }
}

/**
 * The erase branch at $2319: blank the string's cells with character $40.
 * @param {import('../machine/machine.js').Machine} m
 * @param {{charAddr: number, bytes: readonly number[]}} entry
 */
function eraseText(m, entry) {
  let addr = entry.charAddr;
  for (const byte of entry.bytes) {
    if (byte === TERMINATOR) return;
    putChar(m, addr, ERASE_CHAR);
    addr += STEP;
  }
}

/**
 * The scroll branch at $2323: blank the whole tilemap column the string lives
 * in, park its scroll register off screen, and let HANDLE_TEXT_SCROLL drip the
 * characters in one at a time.
 *
 * Because a tilemap column is a screen *row*, this slides a line of text in
 * horizontally from the edge.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {{charAddr: number, bytes: readonly number[]}} entry
 */
function beginColumnScroll(m, entry) {
  const charAddr = entry.charAddr;
  m.poke16(VAR.COLUMN_SCROLL_CHAR_RAM_PTR, charAddr);
  // The "next character" pointer is an index into the string, which the ROM
  // holds as a ROM address; we keep the index and the entry instead.
  m.poke16(VAR.COLUMN_SCROLL_NEXT_CHAR_PTR, 0);
  scrollState.entry = entry;
  scrollState.next = 0;

  const column = charAddr & 0x1f;
  const attrAddr = 0x4020 + column * 2;
  m.poke16(VAR.COLUMN_SCROLL_ATTR_BACKBUF_PTR, attrAddr);

  // Initial scroll offset, from $2338-$2344.
  const lo = charAddr & 0xff;
  const hi = (charAddr >> 8) & 0xff;
  const offset = ((((hi & 3) << 6) | (lo >> 2)) & 0xf8) & 0xff;

  // Clear the whole column before scrolling anything into it.
  for (let row = 0; row < 32; row += 1) putChar(m, 0x5000 + row * 32 + column, 0x10);

  m.poke(attrAddr, offset);
  m.poke(VAR.IS_COLUMN_SCROLLING, 1);
}

/**
 * The scroll in progress. The ROM keeps a raw ROM pointer in
 * COLUMN_SCROLL_NEXT_CHAR_PTR; since our strings are a JavaScript array we hold
 * the entry and an index here and mirror the progress into RAM so the variable
 * still reads sensibly.
 * @type {{entry: {charAddr: number, bytes: readonly number[]} | null, next: number}}
 */
const scrollState = { entry: null, next: 0 };

/**
 * HANDLE_TEXT_SCROLL ($18C0). Called once per frame from the NMI.
 *
 * Moves the column one pixel per frame and reveals one more character every
 * eight pixels, so a line slides in at about 60 pixels a second.
 *
 * Running out of characters is NOT the end of the animation. At $18D4 the ROM
 * jumps to $18E7 on the terminator, which lands on the `dec (hl)` -- it skips
 * the character write and keeps travelling. Only the scroll offset reaching
 * zero at $18E9 clears IS_COLUMN_SCROLLING, and zero is the line's final
 * position. Stopping on the terminator instead parks the line wherever the
 * last character happened to land: the NAMCO logo is 8 characters against a
 * starting offset of $98, so it used to freeze 88 pixels short, sliced by the
 * wrap at the edge of the tilemap.
 *
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleTextScroll(m) {
  if ((m.peek(VAR.IS_COLUMN_SCROLLING) & 1) === 0) return;

  const attrAddr = m.peek16(VAR.COLUMN_SCROLL_ATTR_BACKBUF_PTR);
  const offset = m.peek(attrAddr);

  // Every eighth pixel of travel brings on the next character.
  if ((offset & 7) === 0) {
    const entry = scrollState.entry;
    const byte = entry === null ? undefined : entry.bytes[scrollState.next];
    // $18D1-$18D4: the terminator only suppresses the write. Past the end of
    // the string the column simply carries the characters already placed.
    if (byte !== undefined && byte !== TERMINATOR) {
      const charAddr = m.peek16(VAR.COLUMN_SCROLL_CHAR_RAM_PTR);
      putChar(m, charAddr, (byte - 0x30) & 0xff);
      m.poke16(VAR.COLUMN_SCROLL_CHAR_RAM_PTR, (charAddr + STEP) & 0xffff);
      scrollState.next += 1;
      m.poke16(VAR.COLUMN_SCROLL_NEXT_CHAR_PTR, scrollState.next);
    }
  }

  // $18E8-$18ED: one pixel of travel, and the scroll ends only at zero.
  const next = (offset - 1) & 0xff;
  m.poke(attrAddr, next);
  if (next === 0) {
    m.poke(VAR.IS_COLUMN_SCROLLING, 0);
    scrollState.entry = null;
  }
}

/** Abandon any scroll in progress, for a screen change. */
export function resetTextScroll(m) {
  m.poke(VAR.IS_COLUMN_SCROLLING, 0);
  scrollState.entry = null;
  scrollState.next = 0;
}
