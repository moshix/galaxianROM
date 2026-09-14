/**
 * Reading the board.
 *
 * The only file in `src/ai/` that touches a `Machine`. Everything downstream --
 * the oscillator, the path predictors, the escape search -- works on plain
 * numbers, which is what lets all of it be tested in Node with no emulator and
 * checked directly against the game's own update code.
 *
 * Nothing here allocates. The threat windows and the sample records are made
 * once and refilled every frame, because this runs sixty times a second
 * alongside a full arcade board emulation and a 224x256 repaint, and a steady
 * drip of short-lived objects costs more than all the arithmetic put together.
 */

import { VAR, BLOCK, ENEMY_BULLET, INFLIGHT_ALIEN } from '../machine/addresses.js';
import { SWING } from '../game/inflight.js';
import { int8 } from '../game/rng.js';
import { predictBullet, predictDiver, makeThreatWindow } from './paths.js';
import { MAX_THREATS, HORIZON_FRAMES } from './constants.js';

/** Slot 0 is the shared explosion scratch, never a flying alien. */
const FIRST_FLYING_SLOT = 1;
const FLYING_SLOTS = 7;

/**
 * Everything the decision code needs about the world this frame.
 * @typedef {object} World
 * @property {number} playerY @property {number} timing
 * @property {number} bulletFired @property {number} shocked
 * @property {number} aggressive @property {number} levelComplete
 * @property {number} noSwarm
 */

export class ThreatReader {
  constructor() {
    /** @type {import('./paths.js').ThreatWindow[]} */
    this.windows = [];
    for (let i = 0; i < MAX_THREATS; i += 1) this.windows.push(makeThreatWindow());
    /** Live in-flight alien samples, refilled each frame. */
    this.divers = [];
    for (let i = 0; i < FLYING_SLOTS; i += 1) {
      this.divers.push({
        slot: 0, stage: 0, x: 0, y: 0, pivot: 0, pivotAdd: 0, speed: 0,
        swingL: 0, swingD: 0, swingE: 0, sorties: 0, index: 0,
      });
    }
    this.diverCount = 0;
    this.count = 0;
    /** @type {World} */
    this.world = {
      playerY: 0, timing: 0, bulletFired: 0, shocked: 0,
      aggressive: 0, levelComplete: 0, noSwarm: 0,
    };
  }

  /**
   * Sample the scalars the decision code reads.
   * @param {import('../machine/machine.js').Machine} m
   * @returns {World}
   */
  readWorld(m) {
    const w = this.world;
    w.playerY = m.peek(VAR.PLAYER_Y);
    w.timing = m.peek(VAR.TIMING_VARIABLE);
    w.bulletFired = m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED);
    // While a flagship is dead nothing fires and no sortie launches, and the
    // counter does not even start running down until the sky is clear -- by a
    // distance the safest the board ever gets.
    w.shocked = m.peek(VAR.IS_FLAGSHIP_HIT) & 1;
    w.aggressive = m.peek(VAR.HAVE_AGGRESSIVE_ALIENS) & 1;
    w.levelComplete = m.peek(VAR.LEVEL_COMPLETE) & 1;
    w.noSwarm = m.peek(VAR.HAVE_NO_ALIENS_IN_SWARM) & 1;
    return w;
  }

  /**
   * Sample every in-flight alien that is alive.
   *
   * `IS_ACTIVE` alone is the right liveness test: killing an alien clears it and
   * sets `IS_DYING`, and the collision test checks only `IS_ACTIVE` -- so an
   * exploding alien is genuinely harmless and must not generate an exclusion
   * zone the ship then wastes time avoiding.
   *
   * @param {import('../machine/machine.js').Machine} m
   * @returns {number} how many are live
   */
  readDivers(m) {
    let n = 0;
    for (let i = 0; i < FLYING_SLOTS; i += 1) {
      const slot = FIRST_FLYING_SLOT + i;
      const addr = BLOCK.INFLIGHT_ALIENS.addr + slot * INFLIGHT_ALIEN.SIZE;
      if ((m.peek(addr + INFLIGHT_ALIEN.IS_ACTIVE) & 1) === 0) continue;
      const d = this.divers[n];
      d.slot = slot;
      d.stage = m.peek(addr + INFLIGHT_ALIEN.STAGE_OF_LIFE);
      d.x = m.peek(addr + INFLIGHT_ALIEN.X);
      d.y = m.peek(addr + INFLIGHT_ALIEN.Y);
      d.pivot = m.peek(addr + INFLIGHT_ALIEN.PIVOT_Y_VALUE);
      d.pivotAdd = m.peek(addr + INFLIGHT_ALIEN.PIVOT_Y_VALUE_ADD);
      d.speed = m.peek(addr + INFLIGHT_ALIEN.SPEED);
      d.swingL = m.peek(addr + SWING.VELOCITY);
      d.swingD = m.peek(addr + SWING.OFFSET_FRACTION);
      d.swingE = m.peek(addr + SWING.VELOCITY_FRACTION);
      d.sorties = m.peek(addr + INFLIGHT_ALIEN.SORTIE_COUNT);
      d.index = m.peek(addr + INFLIGHT_ALIEN.INDEX_IN_SWARM);
      n += 1;
    }
    this.diverCount = n;
    return n;
  }

  /**
   * Build this frame's threat windows.
   * @param {import('../machine/machine.js').Machine} m
   * @returns {number} how many windows are live, in `this.windows[0..n)`
   */
  collect(m) {
    const w = this.readWorld(m);
    this.readDivers(m);
    let n = 0;

    for (let i = 0; i < ENEMY_BULLET.COUNT && n < MAX_THREATS; i += 1) {
      const addr = BLOCK.ENEMY_BULLETS.addr + i * ENEMY_BULLET.SIZE;
      if ((m.peek(addr + ENEMY_BULLET.IS_ACTIVE) & 1) === 0) continue;
      const sample = {
        slot: i,
        x: m.peek(addr + ENEMY_BULLET.X),
        yLo: m.peek(addr + ENEMY_BULLET.Y_LO),
        yHi: m.peek(addr + ENEMY_BULLET.Y_HI),
        delta: int8(m.peek(addr + ENEMY_BULLET.Y_DELTA)),
      };
      if (predictBullet(sample, w.timing, HORIZON_FRAMES, this.windows[n])) n += 1;
    }

    for (let i = 0; i < this.diverCount && n < MAX_THREATS; i += 1) {
      if (predictDiver(this.divers[i], w.timing, w.playerY, HORIZON_FRAMES, this.windows[n])) {
        n += 1;
      }
    }

    this.count = n;
    return n;
  }
}
