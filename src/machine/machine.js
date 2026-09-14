/**
 * The Galaxian board, as far as the game code can observe it.
 *
 * The JavaScript port keeps the original's memory layout rather than inventing
 * an object model: game state lives at the addresses the 1979 code used. That
 * is what makes the differential test against the Z80 oracle a byte-for-byte
 * comparison instead of a judgement call, and it means any line of
 * reference/galaxian.asm can be read straight against this code.
 *
 * @see reference/galaxian.asm:92-152 (hardware map)
 * @see reference/galaxian.asm:190-627 (RAM variables)
 */

import { REGION, PORT, VAR, BLOCK, OBJ, INPUT_BIT } from './addresses.js';

/** Displayed playfield, after the 90 degree monitor rotation. */
export const GAME_WIDTH = 224;
export const GAME_HEIGHT = 256;

/** 18.432 MHz / (1152 * 264). @see MAME galaxian.h */
export const FRAME_RATE = 18432000 / (1152 * 264);

/** Z80 runs at master/6; one frame is exactly this many cycles. */
export const CYCLES_PER_FRAME = 50688;

/**
 * Dip switch settings. Defaults match a standard upright cabinet:
 * 1 coin 1 play, bonus ship at 7000, 3 ships per game.
 * @see reference/galaxian.asm:154-183
 */
export class DipSwitches {
  /** SW1/SW2 coinage, bits 0-1 of the value read from $6800 bits 6-7. */
  coinage = 0;
  /** SW3/SW4: 0 = 7000, 1 = 10000, 2 = 12000, 3 = 20000. */
  bonusLife = 0;
  /** SW5: false = 2 ships, true = 3 ships. */
  threeShips = true;
  /** SW6, unused by the game. */
  sw6 = false;
}

export class Machine {
  /** Working RAM, 1 KB physical, mirrored across $4000-$47FF. */
  ram = new Uint8Array(REGION.RAM_SIZE);
  /** 32x32 tilemap, 1 KB, mirrored across $5000-$57FF. */
  charRam = new Uint8Array(REGION.CHAR_RAM_SIZE);
  /** Sprites, bullets, per-column scroll and colour; mirrored across $5800-$5FFF. */
  objRam = new Uint8Array(REGION.OBJ_RAM_SIZE);

  /** Switch state, active high on this board. @see reference/galaxian.asm:820-821 */
  port6000 = 0;
  port6800 = 0;

  dips = new DipSwitches();

  /** Latched video control registers. @see reference/galaxian.asm:143-148 */
  nmiEnabled = false;
  starsEnabled = false;
  hFlip = false;
  vFlip = false;

  /** $6000-$6003 driver outputs. */
  lamp1 = 0; lamp2 = 0; coinLockout = 0; coinControl = 0;
  /** $6004-$6007, background LFO frequency bits. */
  lfo = new Uint8Array(4);
  /** $6800-$6807 sound registers. */
  soundRegs = new Uint8Array(8);
  /** $7800 write: sound FX base pitch. */
  pitch = 0xff;

  /** Incremented by watchdog reads; the real board resets if this stalls. */
  watchdogKicks = 0;

  /**
   * Sound writes are the audio layer's only input, exactly as on the real
   * board. Set by the host to observe them.
   * @type {null | ((addr: number, value: number) => void)}
   */
  onSoundWrite = null;

  /**
   * Decode an address the way the board's chip selects do.
   * Reads outside a decoded region float high.
   * @param {number} addr
   * @returns {number} byte value
   */
  read(addr) {
    const a = addr & 0xffff;
    if (a < 0x4000) return 0xff; // ROM is not mapped in the port; see the oracle for that
    if (a < 0x4800) return this.ram[a & 0x3ff];
    if (a >= 0x5000 && a < 0x5800) return this.charRam[a & 0x3ff];
    if (a >= 0x5800 && a < 0x6000) return this.objRam[a & 0xff];
    if (a >= 0x6000 && a < 0x6800) return this.port6000;
    if (a >= 0x6800 && a < 0x7000) return this.port6800;
    if (a >= 0x7000 && a < 0x7800) return this.readDips();
    if (a >= 0x7800) { this.watchdogKicks += 1; return 0xff; }
    return 0xff;
  }

  /**
   * @param {number} addr
   * @param {number} value
   */
  write(addr, value) {
    const a = addr & 0xffff;
    const v = value & 0xff;
    if (a < 0x4000) return; // ROM, ignored
    if (a < 0x4800) { this.ram[a & 0x3ff] = v; return; }
    if (a >= 0x5000 && a < 0x5800) { this.charRam[a & 0x3ff] = v; return; }
    if (a >= 0x5800 && a < 0x6000) { this.objRam[a & 0xff] = v; return; }
    if (a >= 0x6000 && a < 0x6800) { this.writeDriver(a & 7, v); return; }
    if (a >= 0x6800 && a < 0x7000) { this.writeSound(a & 7, v); return; }
    if (a >= 0x7000 && a < 0x7800) { this.writeVideoControl(a & 7, v); return; }
    if (a >= 0x7800) { this.pitch = v; }
  }

  /** @param {number} reg @param {number} v */
  writeDriver(reg, v) {
    const bit = v & 1;
    switch (reg) {
      case 0: this.lamp1 = bit; break;
      case 1: this.lamp2 = bit; break;
      case 2: this.coinLockout = bit; break;
      case 3: this.coinControl = bit; break;
      default: this.lfo[reg - 4] = bit; break;
    }
  }

  /** @param {number} reg @param {number} v */
  writeSound(reg, v) {
    this.soundRegs[reg] = v & 1;
    if (this.onSoundWrite !== null) this.onSoundWrite(PORT.SOUND_BASE + reg, v);
  }

  /** @param {number} reg @param {number} v */
  writeVideoControl(reg, v) {
    const bit = (v & 1) !== 0;
    switch (reg) {
      case 1: this.nmiEnabled = bit; break;
      case 4: this.starsEnabled = bit; break;
      case 6: this.hFlip = bit; break;
      case 7: this.vFlip = bit; break;
      default: break; // $7002, $7003 and $7005 are unused
    }
  }

  /**
   * Dip switches as the game reads them at $7000.
   * @see reference/galaxian.asm:139-142, 889-893
   * @returns {number}
   */
  readDips() {
    return (this.dips.bonusLife & 3)
      | (this.dips.threeShips ? 0x04 : 0)
      | (this.dips.sw6 ? 0x08 : 0);
  }

  // -- Named variable access -------------------------------------------------
  // Direct, unmirrored access for the ported game logic. Faster than going
  // through read()/write(), and it reads like the disassembly.

  /** @param {number} addr @returns {number} */
  peek(addr) { return this.ram[addr & 0x3ff]; }

  /** @param {number} addr @param {number} v */
  poke(addr, v) { this.ram[addr & 0x3ff] = v & 0xff; }

  /** Little-endian 16-bit read, as the Z80's `ld hl,(nn)` does. @param {number} addr */
  peek16(addr) {
    return this.ram[addr & 0x3ff] | (this.ram[(addr + 1) & 0x3ff] << 8);
  }

  /** @param {number} addr @param {number} v */
  poke16(addr, v) {
    this.ram[addr & 0x3ff] = v & 0xff;
    this.ram[(addr + 1) & 0x3ff] = (v >> 8) & 0xff;
  }

  /**
   * Copy the sprite/colour back buffer into OBJRAM, which the NMI handler does
   * with a single LDIR at the very top of every frame. Because this happens
   * before the frame's logic runs, what the player sees always lags the
   * simulation by one frame — a detail the port must keep.
   * @see reference/galaxian.asm:799-802
   */
  blitBackBuffer() {
    const src = BLOCK.OBJRAM_BACK_BUF.addr & 0x3ff;
    this.objRam.set(this.ram.subarray(src, src + BLOCK.OBJRAM_BACK_BUF.size), 0);
  }

  // -- Input -----------------------------------------------------------------

  /**
   * Set or clear one switch. Inputs are active high on this board.
   * @param {'coin1'|'coin2'|'left'|'right'|'fire'|'start1'|'start2'|'p2left'|'p2right'|'p2fire'|'test'|'service'|'cocktail'} name
   * @param {boolean} down
   */
  setInput(name, down) {
    const on6000 = {
      coin1: INPUT_BIT.COIN1, coin2: INPUT_BIT.COIN2,
      left: INPUT_BIT.P1_LEFT, right: INPUT_BIT.P1_RIGHT, fire: INPUT_BIT.P1_SHOOT,
      cocktail: INPUT_BIT.COCKTAIL, test: INPUT_BIT.TEST, service: INPUT_BIT.SERVICE,
    };
    const on6800 = {
      start1: INPUT_BIT.START1, start2: INPUT_BIT.START2,
      p2left: INPUT_BIT.P2_LEFT, p2right: INPUT_BIT.P2_RIGHT, p2fire: INPUT_BIT.P2_SHOOT,
    };
    if (name in on6000) {
      const mask = 1 << on6000[/** @type {keyof typeof on6000} */ (name)];
      this.port6000 = down ? (this.port6000 | mask) : (this.port6000 & ~mask & 0xff);
      return;
    }
    const mask = 1 << on6800[/** @type {keyof typeof on6800} */ (name)];
    this.port6800 = down ? (this.port6800 | mask) : (this.port6800 & ~mask & 0xff);
  }

  /** Dip switches 1 and 2 appear in the top two bits of $6800. */
  refreshCoinageBits() {
    this.port6800 = (this.port6800 & 0x3f) | ((this.dips.coinage & 3) << 6);
  }

  /** Wipe all state, as a power cycle would. */
  reset() {
    this.ram.fill(0);
    this.charRam.fill(0);
    this.objRam.fill(0);
    this.nmiEnabled = false;
    this.starsEnabled = false;
    this.hFlip = false;
    this.vFlip = false;
    this.soundRegs.fill(0);
    this.lfo.fill(0);
    this.pitch = 0xff;
    this.watchdogKicks = 0;
  }
}

/**
 * Read one in-flight alien field. Records are 32 bytes at $42B0.
 * @param {Machine} m
 * @param {number} slot 0-7
 * @param {number} field offset from INFLIGHT_ALIEN
 * @returns {number}
 */
export function inflight(m, slot, field) {
  return m.peek(BLOCK.INFLIGHT_ALIENS.addr + slot * 32 + field);
}

/**
 * @param {Machine} m
 * @param {number} slot
 * @param {number} field
 * @param {number} value
 */
export function setInflight(m, slot, field, value) {
  m.poke(BLOCK.INFLIGHT_ALIENS.addr + slot * 32 + field, value);
}

/**
 * Read a swarm cell. Index is row*16 + col, rows 2-7, cols 3-12, and note that
 * column 3 is the RIGHTMOST column on screen.
 * @see reference/galaxian.asm:327-356, 424-434
 * @param {Machine} m @param {number} row @param {number} col @returns {number}
 */
export function swarmCell(m, row, col) {
  return m.peek(BLOCK.ALIEN_SWARM_FLAGS.addr + row * 16 + col);
}

export { VAR, BLOCK, OBJ, PORT };
