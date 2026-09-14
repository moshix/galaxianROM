/**
 * The self-playing AI.
 *
 * It is a *controller*, not a cheat: it reads the machine's state but its only
 * output is the same three switches a human has -- left, right, fire -- plus
 * coin and start so a demo can run unattended. It cannot move the ship faster
 * than one pixel per frame, cannot fire while a shot is in flight, and dies to
 * exactly the same hit boxes.
 *
 * WHAT IT IS TRYING TO DO: stay alive. Everything else is downstream of that.
 *
 * The interesting part is not this file, which is mostly arbitration; it is the
 * three ideas underneath it:
 *
 *  - A threat is dangerous over a *span of frames*, not at an instant, and the
 *    ship moves one pixel a frame. So the question is never "is that square
 *    clear" but "can I be somewhere survivable in time". @see ./evade.js
 *  - A diving alien's arc is computable, not guessable: it descends exactly one
 *    pixel a frame and swings sideways on a deterministic oscillator, so where
 *    it will be when it arrives is arithmetic. @see ./paths.js
 *  - A shot that misses costs about fifty frames with no gun. Firing at nothing
 *    is not free, and this AI no longer does it. @see {@link chooseShot}
 *
 * Coordinates take some getting used to, because the cabinet is on its side:
 *   X is VERTICAL, increasing downwards. The player sits at X = 231.
 *   Y is HORIZONTAL, increasing LEFT. The player ranges over 22..233.
 * @see reference/galaxian.asm:69-85
 */

import { VAR, INFLIGHT_ALIEN } from '../machine/addresses.js';
import { ThreatReader } from './threats.js';
import { chooseMove } from './evade.js';
import {
  Y_MIN, Y_MAX, ARRIVED_TOLERANCE, BULLET_SPAWN_X, PLAYER_BULLET_RISE,
  SHOT_AIM_DY_LOW, SHOT_AIM_DY_HIGH, DIVER_HALF,
  SCROLL_FRAMES_PER_PIXEL, CELL_Y_BIAS, ROW_BASE_X, ROW_PITCH_X,
  STAGE_ATTACKING, STAGE_AGGRESSIVE,
} from './constants.js';
import { ROW_MIN, ROW_MAX, COL_MIN, COL_MAX } from '../game/swarm.js';
import { BLOCK } from '../machine/addresses.js';

/** Frames a diver's trigger must be away before we stop worrying about it. */
const SHOOT_RISK_HORIZON = 24;
/** How far to the side counts as "lined up" with an alien about to fire. */
const SHOOT_RISK_WIDTH = 14;

export class AutoPlayer {
  /** @param {import('../machine/machine.js').Machine} machine */
  constructor(machine) {
    this.m = machine;
    this.reader = new ThreatReader();
    /** Target we are walking towards, for hysteresis. -1 when none. */
    this.heldTarget = -1;
    /** Which way we moved last frame, so reversing can be made to cost. */
    this.lastDirection = 0;
    this.holdCoin = 0;
    /** Diagnostics, readable from the console as `galaxian.ai.telemetry`. */
    this.telemetry = { mode: 'idle', threats: 0, target: -1, tDeath: 0, shot: -1 };
  }

  /**
   * Open every switch. Called at the top of every frame, so no input can stick
   * on any early-return path, and by `setAi(false)` when handing control back.
   * @returns {void}
   */
  release() {
    for (const name of ['left', 'right', 'fire', 'coin1', 'start1']) {
      this.m.setInput(/** @type {'left'} */ (name), false);
    }
  }

  /** One frame of play. @returns {void} */
  step() {
    const m = this.m;
    this.release();

    const script = m.peek(VAR.SCRIPT_NUMBER);
    if (script !== 3 && script !== 4) {
      this.insertCoinAndStart();
      this.telemetry.mode = 'idle';
      this.heldTarget = -1;
      return;
    }

    if (m.peek(VAR.HAS_PLAYER_SPAWNED) === 0 || m.peek(VAR.IS_PLAYER_DYING) !== 0) {
      // Nothing useful to do, and the respawn forces PLAYER_Y itself. Drop the
      // held target so a stale coordinate cannot re-lock the new ship.
      this.telemetry.mode = 'idle';
      this.heldTarget = -1;
      this.lastDirection = 0;
      return;
    }

    const count = this.reader.collect(m);
    const world = this.reader.world;
    const playerY = world.playerY;

    const risk = this.shootRiskFn();
    const move = chooseMove(playerY, this.reader.windows, count, this.heldTarget,
      this.lastDirection, risk);
    this.heldTarget = move.target;

    // Movement is committed before the shot is chosen, because PLAYER_BULLET_Y
    // is copied from PLAYER_Y *after* this frame's move and never revised.
    const firedY = this.moveToward(playerY, move.target);

    this.telemetry.mode = move.safe ? 'aim' : 'dodge';
    this.telemetry.threats = count;
    this.telemetry.target = move.target;
    this.telemetry.tDeath = move.tDeath;

    this.maybeFire(firedY, world);
  }

  /**
   * Coin up and start a game.
   *
   * The 3-held / 15-released cycle is not decoration. CHECK_IF_COIN_INSERTED
   * wants a *release* edge -- the bit clear in the last two samples and set in
   * the two before -- so a permanently held switch is never seen as a coin at
   * all. And start must not be pressed without credit, because HANDLE_START_
   * BUTTONS sends the machine back to attract mode if it is.
   * @see reference/galaxian.asm:6031-6100
   * @returns {void}
   */
  insertCoinAndStart() {
    this.holdCoin = (this.holdCoin + 1) % 18;
    const pressed = this.holdCoin < 3;
    if (!pressed) return;
    this.m.setInput(this.m.peek(VAR.NUM_CREDITS) === 0 ? 'coin1' : 'start1', true);
  }

  /**
   * Push the ship one pixel towards `target`.
   *
   * At most one switch: setting both cancels exactly, and the deadband stops a
   * one-pixel target being chased forever.
   * @param {number} playerY @param {number} target
   * @returns {number} where the ship will be after this frame's move
   */
  moveToward(playerY, target) {
    const delta = target - playerY;
    if (Math.abs(delta) <= ARRIVED_TOLERANCE) { this.lastDirection = 0; return playerY; }
    if (delta > 0) {
      this.m.setInput('left', true);
      this.lastDirection = 1;
      return playerY + 1;
    }
    this.m.setInput('right', true);
    this.lastDirection = -1;
    return playerY - 1;
  }

  /**
   * Fire, but only at something.
   *
   * A shot leaves at X 220 and climbs four pixels a frame until it expires near
   * the top, so a miss costs about fifty frames during which the ship is
   * unarmed. The old AI fired blind whenever it was dodging, which spent the
   * gun on empty sky at exactly the moments it most needed it.
   *
   * @param {number} firedY where PLAYER_BULLET_Y will be
   * @param {import('./threats.js').World} world
   * @returns {void}
   */
  maybeFire(firedY, world) {
    this.telemetry.shot = -1;
    if (world.bulletFired !== 0) return;   // the ROM allows one shot in flight

    const shot = this.chooseShot(firedY);
    if (shot >= 0) {
      this.telemetry.shot = shot;
      this.m.setInput('fire', true);
      return;
    }
    if (this.maySpendShotOnSwarm(world) && this.swarmColumnLinedUp(firedY)) {
      this.m.setInput('fire', true);
    }
  }

  /**
   * Which in-flight alien this frame's shot would hit, if any.
   *
   * The intercept is closed form: the shot climbs four pixels a frame while a
   * diver descends one, so they close at five into a six-pixel window, which
   * pins the meeting to one or two frames. The predicted sideways error is then
   * required to be two pixels inside the real window on each side, because
   * being wrong costs fifty frames and being cautious costs nothing.
   *
   * @param {number} firedY
   * @returns {number} slot, or -1
   */
  chooseShot(firedY) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < this.reader.diverCount; i += 1) {
      const d = this.reader.divers[i];
      if (d.stage !== STAGE_ATTACKING && d.stage !== STAGE_AGGRESSIVE) continue;

      const firstFrame = Math.ceil((BULLET_SPAWN_X - 2 - d.x) / (PLAYER_BULLET_RISE + 1));
      const lastFrame = Math.floor((BULLET_SPAWN_X + 3 - d.x) / (PLAYER_BULLET_RISE + 1));
      let hits = false;
      for (let f = Math.max(1, firstFrame); f <= lastFrame && !hits; f += 1) {
        // The alien's Y f frames out; the swing makes this predictable, and the
        // threat reader has already done the work for anything that reaches us.
        const dy = this.predictedDiverY(i, f) - firedY;
        if (dy >= SHOT_AIM_DY_LOW && dy <= SHOT_AIM_DY_HIGH) hits = true;
      }
      if (!hits) continue;

      // A flagship is worth far more than its points: killing a diving one
      // stops every alien firing until the sky clears.
      const score = (d.index >= 0x70 ? 1000 : 0) + (255 - d.x);
      if (score > bestScore) { bestScore = score; best = d.slot; }
    }
    return best;
  }

  /**
   * Where diver `i` will be `f` frames from now, reusing the threat window when
   * one was built and falling back to its current Y otherwise.
   * @param {number} i @param {number} f
   * @returns {number}
   */
  predictedDiverY(i, f) {
    const slot = this.reader.divers[i].slot;
    for (let t = 0; t < this.reader.count; t += 1) {
      const w = this.reader.windows[t];
      if (w.kind === 1 && w.slot === slot && f >= w.first && f <= w.last) {
        return w.track[f - w.first];
      }
    }
    return this.reader.divers[i].y;
  }

  /**
   * May the gun be spent on the formation?
   *
   * Only with an empty sky. With nothing flying and nothing fired, the soonest a
   * new sortie can threaten the ship is its peel-off arc plus a full dive --
   * comfortably longer than the fifty-frame lockout, so the shot is free. With
   * anything in the air it is not, and survival comes first.
   * @param {import('./threats.js').World} world
   * @returns {boolean}
   */
  maySpendShotOnSwarm(world) {
    if (world.levelComplete !== 0 || world.noSwarm !== 0) return false;
    return this.reader.diverCount === 0 && this.reader.count === 0;
  }

  /**
   * Is a swarm column lined up with where the shot will be?
   *
   * The lead is the formation's travel during the shot's *whole* flight to that
   * row. The old code led by the pre-freeze portion only, on the theory that
   * the swarm stops when a shot enters its band -- but the freeze window and the
   * hit window are disjoint sets of cell offsets, so a shot that freezes the
   * formation can never hit it. The freeze only ever turns a near miss into a
   * certain one, and leading for it made the top rows systematic misses.
   * @see src/game/swarm.js `isSwarmFrozenByPlayerBullet`
   * @param {number} firedY
   * @returns {boolean}
   */
  swarmColumnLinedUp(firedY) {
    const m = this.m;
    const scroll = m.peek(VAR.SWARM_SCROLL_VALUE);
    const direction = m.peek(VAR.SWARM_DIRECTION) === 0 ? 1 : -1;

    for (let col = COL_MIN; col <= COL_MAX; col += 1) {
      let row = -1;
      for (let r = ROW_MIN; r <= ROW_MAX; r += 1) {
        if ((m.peek(BLOCK.ALIEN_SWARM_FLAGS.addr + r * 16 + col) & 1) !== 0) { row = r; break; }
      }
      if (row < 0) continue;

      // Flight time to this row's band, then the formation's travel over it.
      const rowX = (ROW_BASE_X - ROW_PITCH_X * (ROW_MAX - row)) & 0xff;
      const frames = Math.max(0, (BULLET_SPAWN_X - rowX) / PLAYER_BULLET_RISE);
      const lead = direction * Math.floor(frames / SCROLL_FRAMES_PER_PIXEL);
      const y = (scroll + lead + col * 16 + CELL_Y_BIAS) & 0xff;
      // Unreachable columns are not targets: chasing one pins the ship against
      // a wall where it can never satisfy its own aim tolerance.
      if (y < Y_MIN || y > Y_MAX) continue;
      if (Math.abs(y - firedY) <= 2) return true;
    }
    return false;
  }

  /**
   * A penalty function over positions: being lined up with a diver that is
   * about to pull its trigger is much worse than it looks, because the aim is
   * computed at the moment of firing and points straight at us.
   * @returns {(y: number) => number}
   */
  shootRiskFn() {
    const m = this.m;
    const exactX = m.peek(VAR.INFLIGHT_ALIEN_SHOOT_EXACT_X);
    const mul = m.peek(VAR.INFLIGHT_ALIEN_SHOOT_RANGE_MUL);
    /** @type {number[]} */
    const risky = [];
    if ((m.peek(VAR.IS_FLAGSHIP_HIT) & 1) === 0) {
      for (let i = 0; i < this.reader.diverCount; i += 1) {
        const d = this.reader.divers[i];
        if (d.stage !== STAGE_ATTACKING && d.stage !== STAGE_AGGRESSIVE) continue;
        // X climbs one a frame; it fires at exactX, or any multiple of 25 below.
        let x = d.x;
        let tries = mul === 0 ? 256 : mul;
        let frames = -1;
        for (let t = 0; t < tries; t += 1) {
          const target = (exactX - t * 0x19) & 0xff;
          if (target >= x && target - x < SHOOT_RISK_HORIZON) {
            frames = target - x;
            break;
          }
        }
        if (frames >= 0) risky.push(this.predictedDiverY(i, Math.max(1, frames)));
      }
    }
    if (risky.length === 0) return () => 0;
    return (y) => {
      let n = 0;
      for (const ry of risky) if (Math.abs(ry - y) <= SHOOT_RISK_WIDTH) n += 1;
      return n;
    };
  }
}

export { DIVER_HALF };
export default AutoPlayer;
