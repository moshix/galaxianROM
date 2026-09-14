/**
 * Choosing where to stand.
 *
 * The old AI picked the nearest clear pixel. The flaw in that is not the
 * "clear" part, it is that the ship moves **one pixel a frame**: a gap 40 px
 * away is worthless against something arriving in ten frames, and picking it
 * feels like dodging right up until the moment it doesn't work. Reachability is
 * the whole game, and it is what this file adds.
 *
 * The search is over absolute positions rather than left/right/stay, because a
 * position is a commitment the next frame can re-examine cheaply, and because
 * scoring positions makes "nowhere is safe" a smooth degradation -- the best of
 * a bad set -- rather than a special case that falls back to a blind jump.
 *
 * Cost is kept down by a shape fact rather than by cleverness: under
 * bang-then-stop the ship's path is monotone, so its whole excursion during a
 * threat's window is an interval, and most candidate/threat pairs are rejected
 * by one interval-overlap test.
 */

import {
  Y_MIN, Y_MAX, HORIZON_FRAMES, ROOM_CAP, CLEAR_CAP,
  W_SURVIVAL, W_ROOM, W_CLEAR, W_SHOOT_RISK, W_COST, W_HOLD,
  HOLD_MARGIN, REVERSE_MARGIN,
} from './constants.js';
import { HUG_CAP } from './paths.js';

/**
 * Where the ship is at frame `f` if it commits to `target` now.
 *
 * It walks one pixel a frame and stops on arrival, which is exactly what a
 * target-seeking controller executes. Because we re-plan every frame the
 * restriction costs nothing: a plan is only ever followed for one frame.
 *
 * @param {number} playerY @param {number} target @param {number} frame
 * @returns {number}
 */
export function shipPositionAt(playerY, target, frame) {
  const delta = target - playerY;
  const step = Math.min(Math.abs(delta), frame);
  return delta >= 0 ? playerY + step : playerY - step;
}

/**
 * The first frame at which committing to `target` gets the ship killed.
 *
 * Returns `horizon` when nothing does, which is what makes the score below
 * saturate for every safe choice instead of preferring absurdly distant ones.
 *
 * @param {number} playerY @param {number} target
 * @param {import('./paths.js').ThreatWindow[]} threats @param {number} count
 * @param {number} horizon
 * @returns {number}
 */
export function earliestViolation(playerY, target, threats, count, horizon) {
  let earliest = horizon;
  for (let t = 0; t < count; t += 1) {
    const w = threats[t];
    if (w.first >= earliest) continue;      // a later threat cannot improve on this

    const widest = w.half + Math.min(w.halfGrow * w.last, HUG_CAP);
    const a = shipPositionAt(playerY, target, w.first);
    const b = shipPositionAt(playerY, target, w.last);
    const shipLo = a < b ? a : b;
    const shipHi = a < b ? b : a;
    // One interval-overlap test rejects most pairs outright. It is deliberately
    // conservative -- two points can cross without ever coinciding -- so it only
    // ever sends us into the exact walk below, never past it.
    if (shipHi < w.yMin - widest || shipLo > w.yMax + widest) continue;

    for (let f = w.first; f <= w.last && f < earliest; f += 1) {
      const half = w.half + Math.min(w.halfGrow * f, HUG_CAP);
      const ship = shipPositionAt(playerY, target, f);
      if (Math.abs(ship - w.track[f - w.first]) <= half) { earliest = f; break; }
    }
  }
  return earliest;
}

/**
 * How much slack the safest moment of this plan has, capped.
 *
 * Purely a tie-break between positions that both survive the horizon: given two
 * safe spots, stand in the roomier one.
 *
 * @param {number} playerY @param {number} target
 * @param {import('./paths.js').ThreatWindow[]} threats @param {number} count
 * @returns {number}
 */
function clearance(playerY, target, threats, count) {
  let worst = CLEAR_CAP;
  for (let t = 0; t < count && worst > 0; t += 1) {
    const w = threats[t];
    for (let f = w.first; f <= w.last; f += 1) {
      const half = w.half + Math.min(w.halfGrow * f, HUG_CAP);
      const slack = Math.abs(shipPositionAt(playerY, target, f) - w.track[f - w.first]) - half;
      if (slack < worst) worst = slack;
    }
  }
  return Math.max(0, Math.min(CLEAR_CAP, worst));
}

/**
 * Pick where to stand this frame.
 *
 * The weights are not delicate. `tDeath` is multiplied by enough to dominate
 * everything else put together, so survival is strictly first and the rest only
 * separate positions that are equally survivable. The one term worth
 * understanding is `room`, which is **capped**: past that much wall clearance
 * more room buys nothing, so the middle of the screen is a flat plateau. The
 * ship therefore walks off a wall but has no reason to cross the middle, which
 * is what stops it cruising to dead centre and fidgeting there.
 *
 * @param {number} playerY
 * @param {import('./paths.js').ThreatWindow[]} threats @param {number} count
 * @param {number} heldTarget last frame's target, or -1
 * @param {number} lastDirection -1, 0 or +1
 * @param {(y: number) => number} [shootRisk] divers about to fire on a column
 * @returns {{target: number, tDeath: number, score: number, safe: boolean}}
 */
export function chooseMove(playerY, threats, count, heldTarget, lastDirection, shootRisk) {
  let best = playerY;
  let bestScore = -Infinity;
  let bestDeath = 0;

  for (let c = Y_MIN; c <= Y_MAX; c += 1) {
    const tDeath = earliestViolation(playerY, c, threats, count, HORIZON_FRAMES);
    const room = Math.min(c - Y_MIN, Y_MAX - c);
    let score = W_SURVIVAL * tDeath
      + W_ROOM * Math.min(room, ROOM_CAP)
      - W_COST * Math.abs(c - playerY);
    if (shootRisk !== undefined) score -= W_SHOOT_RISK * shootRisk(c);
    if (c === heldTarget) score += W_HOLD;
    // Only worth the extra passes over the threat list once a candidate is
    // already in contention.
    if (score + W_CLEAR * CLEAR_CAP > bestScore) {
      score += W_CLEAR * clearance(playerY, c, threats, count);
    }

    if (score > bestScore) { best = c; bestScore = score; bestDeath = tDeath; }
  }

  // Hysteresis. A new target has to be meaningfully better than the one we are
  // already walking towards, and better still if it means turning round --
  // otherwise two near-equal options trade places every frame and the ship
  // vibrates instead of moving. Safety skips all of this, because a change in
  // tDeath is worth a thousand points and cannot be outvoted by 30.
  if (heldTarget >= Y_MIN && heldTarget <= Y_MAX && best !== heldTarget) {
    const heldDeath = earliestViolation(playerY, heldTarget, threats, count, HORIZON_FRAMES);
    if (bestDeath <= heldDeath) {
      const heldRoom = Math.min(heldTarget - Y_MIN, Y_MAX - heldTarget);
      let heldScore = W_SURVIVAL * heldDeath
        + W_ROOM * Math.min(heldRoom, ROOM_CAP)
        + W_CLEAR * clearance(playerY, heldTarget, threats, count)
        - W_COST * Math.abs(heldTarget - playerY)
        + W_HOLD;
      if (shootRisk !== undefined) heldScore -= W_SHOOT_RISK * shootRisk(heldTarget);

      const reversing = lastDirection !== 0
        && Math.sign(best - playerY) !== 0
        && Math.sign(best - playerY) !== lastDirection;
      const needed = HOLD_MARGIN + (reversing ? REVERSE_MARGIN : 0);
      if (bestScore < heldScore + needed) {
        return { target: heldTarget, tDeath: heldDeath, score: heldScore, safe: heldDeath >= HORIZON_FRAMES };
      }
    }
  }

  return { target: best, tDeath: bestDeath, score: bestScore, safe: bestDeath >= HORIZON_FRAMES };
}
