/**
 * Scoring, the extra life, and the high score.
 *
 * Scores are three bytes of packed BCD, little endian: byte 0 holds the units
 * and tens, byte 1 the hundreds and thousands, byte 2 the ten-thousands and
 * hundred-thousands. The ROM adds them with `adc` followed by `daa`, so the
 * port has to reproduce DAA faithfully or scores silently drift.
 *
 * @see reference/galaxian.asm:279-286 (layout)
 * @see reference/galaxian.asm:7563-7625 (UPDATE_PLAYER_SCORE_COMMAND)
 */

import { VAR, BLOCK } from '../machine/addresses.js';
import { ALIEN_SCORE_TABLE_BCD } from './tables.js';
import { putChar, plot2x2Descending, BLANK, BLANK_2X2_DESCENDING } from './plot.js';

/** Character ordinal of the digit glyphs the score uses. @see .asm:7788 */
const DIGIT_BASE = 0x90;

/** Character RAM addresses the scores are drawn at. @see .asm:7704-7730 */
const SCORE_CHAR_ADDR = Object.freeze({ player1: 0x5381, player2: 0x5121, high: 0x5241 });

/** Score slots, matching the parameter of RESET_SCORE and DISPLAY_SCORE. */
export const SCORE = Object.freeze({ PLAYER_ONE: 0, PLAYER_TWO: 1, HIGH: 2, ALL: 3 });

/**
 * One step of the ROM's `adc a,(hl)` + `daa` pair.
 *
 * DAA is the instruction people get wrong. After an addition it adds 6 to the
 * low nibble if that nibble exceeded 9 or the half-carry is set, and 0x60 to
 * the high nibble if the byte exceeded 0x99 or carry is set -- and the second
 * test uses the value *before* the low-nibble correction is applied.
 *
 * @param {number} a accumulator
 * @param {number} operand
 * @param {number} carryIn
 * @returns {{value: number, carry: number}}
 */
export function bcdAdd(a, operand, carryIn) {
  const sum = (a & 0xff) + (operand & 0xff) + (carryIn & 1);
  const halfCarry = ((a & 0x0f) + (operand & 0x0f) + (carryIn & 1)) > 0x0f;
  const raw = sum & 0xff;

  let correction = 0;
  let carry = sum > 0xff ? 1 : 0;
  if (halfCarry || (raw & 0x0f) > 9) correction |= 0x06;
  if (carry === 1 || raw > 0x99) { correction |= 0x60; carry = 1; }

  return { value: (raw + correction) & 0xff, carry };
}

/**
 * LEA_DE_OF_CURRENT_PLAYER_SCORE ($2290).
 * @param {import('../machine/machine.js').Machine} m
 * @returns {number} address of the current player's three score bytes
 */
export function currentScoreAddress(m) {
  return m.peek(VAR.CURRENT_PLAYER) === 0
    ? BLOCK.PLAYER_ONE_SCORE.addr
    : BLOCK.PLAYER_TWO_SCORE.addr;
}

/**
 * Read a three byte BCD score as a decimal number. Presentation only; the game
 * never does this.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr
 * @returns {number}
 */
export function readScore(m, addr) {
  let out = 0;
  for (let i = 2; i >= 0; i -= 1) {
    const byte = m.peek(addr + i);
    out = out * 100 + (byte >> 4) * 10 + (byte & 0x0f);
  }
  return out;
}

/**
 * UPDATE_PLAYER_SCORE_COMMAND ($21A6). Award the points at `index` in
 * ALIEN_SCORE_TABLE to the current player.
 *
 * Aborts immediately if the game is over -- the ROM does this by having
 * `rst $08` discard the caller's return address, which is a neat trick and a
 * plain early return here.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index 0-10, see docs/game-rules.md section 6.3
 * @returns {boolean} true if the score changed
 */
export function updatePlayerScore(m, index) {
  if ((m.peek(VAR.IS_GAME_OVER) & 1) !== 0) return false;

  const scoreAddr = currentScoreAddress(m);
  const points = ALIEN_SCORE_TABLE_BCD[index];
  if (points === undefined) return false;

  // Re-encode the decimal table value back into the ROM's three BCD bytes.
  const digits = String(points).padStart(6, '0');
  const operand = [
    Number.parseInt(digits.slice(4, 6), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(0, 2), 16),
  ];

  let carry = 0;
  for (let i = 0; i < 3; i += 1) {
    const result = bcdAdd(m.peek(scoreAddr + i), operand[i], carry);
    m.poke(scoreAddr + i, result.value);
    carry = result.carry;
  }

  checkExtraLife(m, scoreAddr);
  displayScore(m, m.peek(VAR.CURRENT_PLAYER));
  updateHighScore(m, scoreAddr);
  return true;
}

/**
 * The BONUS GALIXIP check ($21C0-$21CF).
 *
 * The ROM shifts the top two score bytes left by four and compares the high
 * byte against the threshold, which works out as "score in thousands, modulo
 * 100, in BCD". Only the ten-thousands and thousands digits participate, but
 * since the award is a one-shot that does not matter.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} scoreAddr
 */
function checkExtraLife(m, scoreAddr) {
  const hl = (m.peek(scoreAddr + 2) << 8) | m.peek(scoreAddr + 1);
  const thousands = ((hl << 4) >> 8) & 0xff;
  if (thousands >= m.peek(VAR.BONUS_GALIXIP_FOR)) awardExtraLife(m);
}

/**
 * AWARD_EXTRA_LIFE ($229C). One per player per game, ever.
 * @see reference/galaxian.asm:7809-7823
 * @param {import('../machine/machine.js').Machine} m
 * @returns {boolean} true if a life was actually granted
 */
export function awardExtraLife(m) {
  const flagAddr = VAR.PLAYER_ONE_AWARDED_EXTRA_LIFE + m.peek(VAR.CURRENT_PLAYER);
  if (m.peek(flagAddr) !== 0) return false;
  m.poke(flagAddr, 1);
  m.poke(VAR.PLAY_EXTRA_LIFE_SOUND, 1);
  const lives = (m.peek(VAR.PLAYER_LIVES) + 1) & 0xff;
  m.poke(VAR.PLAYER_LIVES, lives);
  displayShipsRemaining(m, lives);
  return true;
}

/**
 * UPDATE_HIGH_SCORE ($21E9), including the comparison that precedes it.
 *
 * The compare walks from the most significant byte down and bails on the first
 * difference, so a tie leaves the high score untouched.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} scoreAddr
 * @returns {boolean} true if a new high score was set
 */
export function updateHighScore(m, scoreAddr) {
  const high = BLOCK.HI_SCORE.addr;
  let beats = false;
  for (let i = 2; i >= 0; i -= 1) {
    const mine = m.peek(scoreAddr + i);
    const theirs = m.peek(high + i);
    if (mine < theirs) return false;
    if (mine > theirs) { beats = true; break; }
  }
  if (!beats) return false;
  for (let i = 0; i < 3; i += 1) m.poke(high + i, m.peek(scoreAddr + i));
  plotScore(m, high, SCORE_CHAR_ADDR.high);
  return true;
}

/**
 * RESET_SCORE_COMMAND ($21FE).
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} which see {@link SCORE}
 */
export function resetScore(m, which) {
  if (which >= SCORE.ALL) {
    for (const slot of [SCORE.HIGH, SCORE.PLAYER_TWO, SCORE.PLAYER_ONE]) resetScore(m, slot);
    return;
  }
  if (which === SCORE.PLAYER_ONE) {
    for (let i = 0; i < 3; i += 1) m.poke(BLOCK.PLAYER_ONE_SCORE.addr + i, 0);
    m.poke(VAR.PLAYER_ONE_AWARDED_EXTRA_LIFE, 0);
  } else if (which === SCORE.PLAYER_TWO) {
    for (let i = 0; i < 3; i += 1) m.poke(BLOCK.PLAYER_TWO_SCORE.addr + i, 0);
    m.poke(VAR.PLAYER_TWO_AWARDED_EXTRA_LIFE, 0);
  } else {
    for (let i = 0; i < 3; i += 1) m.poke(BLOCK.HI_SCORE.addr + i, 0);
  }
  displayScore(m, which);
}

/**
 * DISPLAY_SCORE_COMMAND ($2231).
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} which see {@link SCORE}
 */
export function displayScore(m, which) {
  if (which >= SCORE.ALL) {
    displayScore(m, SCORE.HIGH);
    displayScore(m, SCORE.PLAYER_TWO);
    displayScore(m, SCORE.PLAYER_ONE);
    return;
  }
  if (which === SCORE.PLAYER_ONE) {
    plotScore(m, BLOCK.PLAYER_ONE_SCORE.addr, SCORE_CHAR_ADDR.player1);
  } else if (which === SCORE.PLAYER_TWO) {
    // Player two's score is simply not drawn in a one player game.
    if (m.peek(VAR.IS_TWO_PLAYER_GAME) === 0) return;
    plotScore(m, BLOCK.PLAYER_TWO_SCORE.addr, SCORE_CHAR_ADDR.player2);
  } else {
    plotScore(m, BLOCK.HI_SCORE.addr, SCORE_CHAR_ADDR.high);
  }
}

/**
 * PLOT_SCORE_CHARACTERS ($2261) and PLOT_LOWER_NIB_AS_DIGIT ($2279).
 *
 * Six digits, most significant first, walking *up* character RAM 32 bytes at a
 * time (which is leftwards on the rotated screen). Up to four leading zeros are
 * replaced by spaces, which is why a fresh score reads as "    00" rather than
 * "000000".
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} scoreAddr
 * @param {number} charAddr
 */
export function plotScore(m, scoreAddr, charAddr) {
  let addr = charAddr;
  let skippable = 4;
  for (let byte = 2; byte >= 0; byte -= 1) {
    const packed = m.peek(scoreAddr + byte);
    for (const nibble of [(packed >> 4) & 0x0f, packed & 0x0f]) {
      let ordinal;
      if (nibble !== 0) {
        skippable = 0;                       // once a real digit appears, print them all
        ordinal = DIGIT_BASE + nibble;
      } else if (skippable > 0) {
        skippable -= 1;
        ordinal = BLANK;
      } else {
        ordinal = DIGIT_BASE;
      }
      putChar(m, addr, ordinal);
      addr -= 32;
    }
  }
}

/**
 * DISPLAY_PLAYER_SHIPS_REMAINING ($22B3). The row of spare-ship icons along the
 * bottom of the screen.
 *
 * The count arrives in register B from the caller rather than being read here,
 * and the routine subtracts the ship currently in play. Note the underflow: if
 * it is asked to draw 0 ships while the player is on screen, `dec b` wraps to
 * 255 and the `djnz` loop scribbles icons backwards through character RAM. That
 * is real original behaviour, reproduced rather than papered over -- the game
 * avoids it by clamping lives on underflow in HANDLE_PLAYER_HIT (.asm:4711).
 *
 * @see reference/galaxian.asm:7827-7842
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} count value the caller placed in B, normally PLAYER_LIVES
 */
export function displayShipsRemaining(m, count) {
  let addr = 0x539e;
  let cells = 5;
  let icons = count & 0xff;

  if (m.peek(VAR.HAS_PLAYER_SPAWNED) !== 0) {
    icons = (icons - 1) & 0xff;
    if (icons === 0) { blankRemaining(m, addr, cells); return; }
  }

  // `djnz` runs at least once, so a count of 0 here means 256 iterations.
  let remaining = icons === 0 ? 256 : icons;
  while (remaining > 0) {
    plot2x2Descending(m, 0x66, addr);
    addr -= 64;
    cells -= 1;
    remaining -= 1;
  }
  blankRemaining(m, addr, cells);
}

/**
 * The tail of the routine at $22C9: fill the unused icon slots with blanks
 * until the cell counter goes negative.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr
 * @param {number} cells
 */
function blankRemaining(m, addr, cells) {
  let at = addr;
  let left = cells;
  for (;;) {
    left -= 1;
    // `ret m` -- the sign flag on an 8-bit decrement, so this ends at -1.
    if (((left & 0xff) & 0x80) !== 0) return;
    plot2x2Descending(m, BLANK_2X2_DESCENDING, at);
    at -= 64;
  }
}
