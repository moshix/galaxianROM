/**
 * Drawing the alien formation.
 *
 * Aliens sitting in the swarm are *characters*, not sprites -- only aliens in
 * flight get sprites. That is why the formation can hold 46 aliens on hardware
 * with eight sprite slots, and why the whole swarm slides sideways by writing
 * nine per-column scroll registers rather than moving 46 objects.
 *
 * The foreground loop redraws one column of six cells whenever it finds the
 * command queue empty, so a full pass takes sixteen frames and the wing-flap
 * ripples across the formation rather than moving in lockstep.
 *
 * @see reference/galaxian.asm:7211-7248 (HANDLE_SWARM_ANIMATION)
 * @see reference/galaxian.asm:7339-7373 (GET_ALIEN_CHAR_RAM_ADDR)
 * @see reference/galaxian.asm:7444-7464 (DRAW_ALIEN)
 */

import { VAR, BLOCK } from '../machine/addresses.js';
import {
  ALIEN_SWARM_CHARACTERS_SET_1x2, ALIEN_SWARM_CHARACTERS_SET_2x2,
} from './tables.js';
import { plot2x2Ascending, plotPairAcross, putChar, BLANK_2X2, BLANK } from './plot.js';

/** The flagship's 2x2 character, which never animates. @see .asm:7455 */
const FLAGSHIP_CHAR = 0xa4;

/** Marker CALCULATE_ALIEN_ANIMATION_FRAME_INDEX returns for a flagship. */
const FLAGSHIP_MARKER = 0x80;

/**
 * GET_ALIEN_CHAR_RAM_ADDR ($20E1).
 *
 * Works out where a swarm cell is drawn, and whether it is a 1x2 or a 2x2
 * character group. The ROM computes the row offset as
 * `~((row >> 1) + row + (row & 1)) & 0x0F`, which lands the six rows on
 * character offsets 4, 6, 7, 9, 10 and 12 -- the uneven spacing that makes the
 * rows sit exactly 12 pixels apart on a grid of 8 pixel characters.
 *
 * @param {number} index swarm index, row * 16 + column
 * @returns {{addr: number, twoByTwo: boolean}}
 */
export function getAlienCharRamAddr(index) {
  const column = index & 0x0f;
  const row = (index >> 4) & 0x07;
  const rowOffset = (~(((row >> 1) + row + (row & 1)) & 0xff)) & 0x0f;
  return {
    addr: 0x5000 + column * 64 + rowOffset,
    // Odd rows (flagship, purple, middle blue) are drawn as 2x2 so their
    // artwork can sit four pixels lower inside the character grid.
    twoByTwo: (row & 1) !== 0,
  };
}

/**
 * CALCULATE_ALIEN_ANIMATION_FRAME_INDEX ($211D).
 *
 * Only the low two bits survive, so the frame is
 * `(TIMING_VARIABLE rotated right 4, plus the alien's index, plus C) & 3`.
 * The phase therefore steps every 16 frames and adjacent columns are one step
 * apart, which is the ripple.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index
 * @param {number} [c] the "randomness" offset, 0 normally
 * @returns {number} 0-3, or FLAGSHIP_MARKER for the flagship row
 */
export function calculateAlienAnimationFrameIndex(m, index, c = 0) {
  if ((index & 0xff) >= 0x70) return FLAGSHIP_MARKER;
  const timing = m.peek(VAR.TIMING_VARIABLE);
  // `rrca` four times is an 8-bit rotate, not a shift.
  const rotated = ((timing >> 4) | (timing << 4)) & 0xff;
  return (rotated + index + c) & 0x03;
}

/**
 * CHOOSE_ANIMATION_FRAME_FOR_ALIEN_REJOINING_SWARM ($2104).
 *
 * An alien sliding back into formation needs to flap in step with its
 * neighbours, so the phase is nudged by -1 when the animation cursor has
 * already passed this column on the current sweep.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index
 * @returns {number}
 */
export function chooseAnimationFrameForAlienRejoiningSwarm(m, index) {
  if ((index & 0xff) >= 0x70) return FLAGSHIP_MARKER;
  const column = index & 0x0f;
  const cursor = m.peek(VAR.TIMING_VARIABLE) & 0x0f;
  const c = cursor < column ? -1 : 0;
  return calculateAlienAnimationFrameIndex(m, index, c);
}

/**
 * DRAW_ALIEN ($2131).
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} frame 0-3, or FLAGSHIP_MARKER
 * @param {{addr: number, twoByTwo: boolean}} where
 */
export function drawAlien(m, frame, where) {
  if (!where.twoByTwo) {
    plotPairAcross(m, ALIEN_SWARM_CHARACTERS_SET_1x2[frame & 3], where.addr);
    return;
  }
  const base = (frame & FLAGSHIP_MARKER) !== 0
    ? FLAGSHIP_CHAR
    : ALIEN_SWARM_CHARACTERS_SET_2x2[frame & 3];
  plot2x2Ascending(m, base, where.addr);
}

/**
 * DRAW_ALIEN_COMMAND ($2055). Queued when an alien rejoins the formation.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index
 */
export function drawAlienCommand(m, index) {
  const where = getAlienCharRamAddr(index);
  drawAlien(m, chooseAnimationFrameForAlienRejoiningSwarm(m, index), where);
}

/**
 * DELETE_ALIEN_COMMAND ($205E). Queued when an alien is shot or peels off.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} index
 */
export function deleteAlienCommand(m, index) {
  const where = getAlienCharRamAddr(index);
  if (where.twoByTwo) plot2x2Ascending(m, BLANK_2X2, where.addr);
  else plotPairAcross(m, BLANK_2X2, where.addr);
}

/**
 * HANDLE_SWARM_ANIMATION ($2067).
 *
 * One column per call, selected by the low nibble of TIMING_VARIABLE. Column 0
 * is never drawn -- that slot goes to the 1UP/2UP blink instead -- which is
 * harmless because column 0 of the flags array is never occupied.
 *
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSwarmAnimation(m) {
  const timing = m.peek(VAR.TIMING_VARIABLE);
  const column = timing & 0x0f;
  if (column === 0) { handle1Up2UpBlinking(m, timing); return; }
  if ((m.peek(VAR.DISABLE_SWARM_ANIMATION) & 1) !== 0) return;

  let index = 0x20 + column; // bottom blue row, this column
  for (let row = 0; row < 6; row += 1) {
    if ((m.peek(BLOCK.ALIEN_SWARM_FLAGS.addr + index) & 1) === 0) {
      deleteAlienCommand(m, index);
    } else {
      drawAlien(m, calculateAlienAnimationFrameIndex(m, index), getAlienCharRamAddr(index));
    }
    index += 0x10;
  }
}

/** Character RAM addresses of the "1UP" and "2UP" labels. @see .asm:7334-7337 */
const LABEL_ADDR = [0x5340, 0x50e0];

/**
 * HANDLE_1UP_2UP_BLINKING ($209C).
 *
 * Bit 4 of TIMING_VARIABLE gives 16 frames on, 16 off -- about 1.9 Hz. In a two
 * player game the *other* player's label is drawn during the off phase, so only
 * the active player's blinks. It never blinks in attract mode, because
 * CAN_BLINK_1UP_2UP is only set while a human is playing.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} timing
 */
export function handle1Up2UpBlinking(m, timing) {
  const inPlay = m.peek(VAR.IS_GAME_IN_PLAY);
  if (inPlay !== 0) m.poke(VAR.CAN_BLINK_1UP_2UP, inPlay);
  else if (m.peek(VAR.CAN_BLINK_1UP_2UP) === 0) return;

  const current = m.peek(VAR.CURRENT_PLAYER);
  const blanked = (timing & 0x10) !== 0;

  if (blanked) {
    writeLabel(m, LABEL_ADDR[current & 1], BLANK, true);
    if (m.peek(VAR.IS_TWO_PLAYER_GAME) === 0) return;
    const other = (current ^ 1) & 1;
    writeLabel(m, LABEL_ADDR[other], other + 1, false);
    return;
  }

  writeLabel(m, LABEL_ADDR[current & 1], (current + 1) & 0xff, false);
  if (m.peek(VAR.IS_GAME_IN_PLAY) === 0) m.poke(VAR.CAN_BLINK_1UP_2UP, 0);
}

/**
 * Write "nUP", or three blanks. Characters step 32 bytes back, which is
 * rightwards on the rotated screen.
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} addr
 * @param {number} first digit ordinal, or BLANK
 * @param {boolean} blankAll
 */
function writeLabel(m, addr, first, blankAll) {
  putChar(m, addr, first);
  putChar(m, addr - 32, blankAll ? BLANK : 0x25); // 'U'
  putChar(m, addr - 64, blankAll ? BLANK : 0x20); // 'P'
}
