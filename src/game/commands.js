/**
 * The circular command queue.
 *
 * Galaxian has two threads of control. The vblank NMI runs all the game logic,
 * and a foreground loop runs continuously in between, drawing things. They talk
 * through a 32-entry ring buffer at $40C0: the NMI *posts* a command and moves
 * on, never touching character RAM itself.
 *
 * Two behaviours here are load-bearing and easy to miss:
 *
 *  - A command posted to a full queue is **silently dropped** ($08FB). It is
 *    not retried and nothing is logged. Reachable under heavy queue pressure.
 *  - Whenever the foreground loop finds the next slot empty it runs
 *    HANDLE_SWARM_ANIMATION instead. That is the *only* thing that animates the
 *    formation, so the swarm's wing-flap is driven by queue idleness.
 *
 * @see reference/galaxian.asm:2616-2643 (QUEUE_COMMAND)
 * @see reference/galaxian.asm:7126-7180 (PROCESS_CIRCULAR_COMMAND_QUEUE)
 */

import { VAR, BLOCK } from '../machine/addresses.js';

/** Queue entries live at $40C0-$40FF: 32 pairs of {command, parameter}. */
const QUEUE_START = BLOCK.CIRC_CMD_QUEUE.addr;
const QUEUE_START_LO = QUEUE_START & 0xff;

/** A byte with bit 7 set marks a free slot; the ROM writes $FF. */
const FREE = 0xff;

/**
 * Command identifiers, in the order of the jump table at $203D.
 * @see reference/galaxian.asm:7161-7169
 */
export const CMD = Object.freeze({
  DRAW_ALIEN: 0,
  DELETE_ALIEN: 1,
  DISPLAY_PLAYER: 2,
  UPDATE_SCORE: 3,
  RESET_SCORE: 4,
  DISPLAY_SCORE: 5,
  PRINT_TEXT: 6,
  BOTTOM_OF_SCREEN: 7,
});

/**
 * Put both queue pointers back to the start and mark every slot free.
 * @see reference/galaxian.asm:6571-6572
 * @param {import('../machine/machine.js').Machine} m
 */
export function resetCommandQueue(m) {
  for (let i = 0; i < BLOCK.CIRC_CMD_QUEUE.size; i += 1) m.poke(QUEUE_START + i, FREE);
  m.poke(VAR.CIRC_CMD_QUEUE_PTR_LO, QUEUE_START_LO);
  m.poke(VAR.CIRC_CMD_QUEUE_PROC_LO, QUEUE_START_LO);
}

/**
 * QUEUE_COMMAND ($08F2). Post a command, or drop it if the queue is full.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} command see {@link CMD}
 * @param {number} parameter
 * @returns {boolean} false if the queue was full and the command was discarded
 */
export function queueCommand(m, command, parameter) {
  const lo = m.peek(VAR.CIRC_CMD_QUEUE_PTR_LO);
  const addr = 0x4000 | lo;
  // Only bit 7 is tested, so any value with the top bit set counts as free.
  if ((m.peek(addr) & 0x80) === 0) return false;

  m.poke(addr, command & 0xff);
  m.poke(0x4000 | ((lo + 1) & 0xff), parameter & 0xff);

  // The pointer is an 8-bit value that wraps past $FE to $00; anything below
  // $C0 means we ran off the end and must go back to the start.
  const next = (lo + 2) & 0xff;
  m.poke(VAR.CIRC_CMD_QUEUE_PTR_LO, next < QUEUE_START_LO ? QUEUE_START_LO : next);
  return true;
}

/**
 * @typedef {(m: import('../machine/machine.js').Machine, parameter: number) => void} CommandHandler
 */

/**
 * PROCESS_CIRCULAR_COMMAND_QUEUE ($200A).
 *
 * On the real board this is an infinite loop that the NMI interrupts. Here it
 * is called once per frame and drains whatever the frame queued.
 *
 * The original runs HANDLE_SWARM_ANIMATION every time it finds an empty slot,
 * which at 3 MHz is thousands of times per frame. That is idempotent -- the
 * routine redraws one swarm column chosen by `TIMING_VARIABLE & 0x0F`, and
 * TIMING_VARIABLE only changes once per frame -- so calling it once after the
 * queue drains produces the same screen for a fraction of the work.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {Partial<Record<number, CommandHandler>>} handlers keyed by {@link CMD}
 * @param {(m: import('../machine/machine.js').Machine) => void} [onIdle] swarm animation
 * @param {number} [budget] safety limit on commands drained per call
 * @returns {number} how many commands were executed
 */
export function processCommandQueue(m, handlers, onIdle, budget = 64) {
  let executed = 0;
  while (executed < budget) {
    const lo = m.peek(VAR.CIRC_CMD_QUEUE_PROC_LO);
    const addr = 0x4000 | lo;
    const command = m.peek(addr);
    // `add a,a` then `jr nc` -- a command byte with bit 7 set is an empty slot.
    if ((command & 0x80) !== 0) break;

    const paramAddr = 0x4000 | ((lo + 1) & 0xff);
    const parameter = m.peek(paramAddr);
    m.poke(addr, FREE);
    m.poke(paramAddr, FREE);

    const next = (lo + 2) & 0xff;
    m.poke(VAR.CIRC_CMD_QUEUE_PROC_LO, next < QUEUE_START_LO ? QUEUE_START_LO : next);

    // The ROM doubles the command and masks to 4 bits, so ids above 7 alias
    // back onto the table rather than running off the end.
    const handler = handlers[((command * 2) & 0x0f) >> 1];
    if (handler !== undefined) handler(m, parameter);
    executed += 1;
  }
  if (onIdle !== undefined) onIdle(m);
  return executed;
}

/**
 * How many commands are waiting. Diagnostic only; the ROM never asks.
 * @param {import('../machine/machine.js').Machine} m
 * @returns {number}
 */
export function pendingCommands(m) {
  let n = 0;
  for (let i = 0; i < BLOCK.CIRC_CMD_QUEUE.size; i += 2) {
    if ((m.peek(QUEUE_START + i) & 0x80) === 0) n += 1;
  }
  return n;
}
