/**
 * Everything the AI believes about the game, in one place, each value traced to
 * where it came from.
 *
 * These are not tuning knobs discovered by playing. Almost all of them are read
 * out of the ROM's own collision tests and movement code, and the handful that
 * are judgement calls say so and say why. Keeping them here rather than spread
 * through the decision code is what makes it possible to check the AI's model
 * of the game against the game.
 */

// ------------------------------------------------------------- the playfield

/**
 * Where the ship sits vertically, and how far left and right it may go.
 *
 * HANDLE_PLAYER_MOVE stops leftward travel at `y >= 0x17` and rightward at
 * `y < 0xe9`, so these are the reachable bounds inclusive.
 * @see reference/galaxian.asm:2402-2438
 */
export const PLAYER_X = 231;
export const Y_MIN = 0x16;
export const Y_MAX = 0xe9;

// -------------------------------------------------------- what kills the ship

/**
 * Enemy bullet lethal band, from TEST_IF_ENEMY_BULLET_HIT_PLAYER.
 *
 * The test is `band = (bulletX + 0x1f) & 0xff`, then nose for `band < 5` and
 * body for `(band - 5) & 0xff < 9`. That resolves to bullet X 225..229 killing
 * within +/-2 of the ship and X 230..238 killing within +/-5. **239 is the
 * first genuinely safe value** -- a bullet level with the ship at X 231 is very
 * much still lethal.
 * @see reference/galaxian.asm:4568-4600
 */
export const BULLET_LETHAL_FIRST_X = 225;
export const BULLET_LETHAL_LAST_X = 238;
export const BULLET_LETHAL_HALF = 5;

/**
 * Diving alien lethal band, from TEST_IF_INFLIGHT_ALIEN_HIT_PLAYER: the same
 * nose/body split two pixels higher and much wider. Alien X 223..227 kills
 * within +/-7, X 228..239 within +/-10.
 * @see reference/galaxian.asm:4650-4679
 */
export const DIVER_LETHAL_FIRST_X = 223;
export const DIVER_LETHAL_LAST_X = 239;
export const DIVER_LETHAL_HALF = 10;

/**
 * Margins added to the lethal half-widths above.
 *
 * PHASE covers the one-pixel ambiguity about whether the k-th move has landed
 * when the k-th collision test runs. SLACK buys one frame of decision latency:
 * sitting exactly on a band edge means a single frame of indecision is fatal.
 * A bullet drifts at most 0.5 px/frame so one pixel buys two frames; a diver
 * can cross 2-3 px/frame so it gets two.
 *
 * The totals -- 7 and 13 -- are deliberately NARROWER than the 9 and 14 this AI
 * used to use. An over-wide band is not free: it manufactures situations where
 * nothing is safe, and the fallback is worse than any real threat.
 */
export const MARGIN_PHASE = 1;
export const MARGIN_SLACK_BULLET = 1;
export const MARGIN_SLACK_DIVER = 2;

export const BULLET_HALF = BULLET_LETHAL_HALF + MARGIN_PHASE + MARGIN_SLACK_BULLET;
export const DIVER_HALF = DIVER_LETHAL_HALF + MARGIN_PHASE + MARGIN_SLACK_DIVER;

/**
 * A state-9 alien past its fourth sortie drags its pivot one pixel a frame
 * toward the ship, so its reachable band widens at exactly that rate. Capped
 * because beyond this the honest answer is "shoot it or already be elsewhere".
 * @see reference/galaxian.asm:3990-4012
 */
export const HUG_GROWTH = 1;
export const HUG_GROWTH_CAP = 11;

// --------------------------------------------------------------- how they move

/** Enemy bullets descend exactly this much every frame, without exception. */
export const BULLET_FALL_PER_FRAME = 2;

/**
 * The dive proper (STAGE_OF_LIFE 3) advances X by one per frame and bails into
 * state 4 at this X; state 9 bails at its own, higher, value. A predictor that
 * models only state 3 predicts nothing useful, because state 3 never reaches
 * the ship.
 * @see reference/galaxian.asm:3826-3838 (state 3), :3990-4012 (state 9)
 */
export const DIVE_HANDOFF_X = 0xb8;
export const DIVE_HANDOFF_X_AGGRESSIVE = 0xc0;

/** Stage-of-life values the predictor understands. */
export const STAGE_ATTACKING = 3;
export const STAGE_NEAR_BOTTOM = 4;
export const STAGE_AGGRESSIVE = 9;

/** The player's shot leaves here and climbs four pixels a frame. */
export const BULLET_SPAWN_X = 0xdc;
export const PLAYER_BULLET_RISE = 4;

/**
 * A shot that hits nothing occupies the only bullet slot from X 220 down to
 * about 16 -- roughly this many frames during which the ship cannot shoot.
 * This is the number that makes firing at nothing expensive.
 */
export const SHOT_LOCKOUT_FRAMES = 51;

/** Player bullet vs in-flight alien window, and the tightened one we aim for. */
export const SHOT_HIT_DY_LOW = -5;
export const SHOT_HIT_DY_HIGH = 6;
export const SHOT_AIM_DY_LOW = -3;
export const SHOT_AIM_DY_HIGH = 4;

/** The formation advances one pixel every fourth frame. */
export const SCROLL_FRAMES_PER_PIXEL = 4;
/** An alien sits this far into its 16-pixel cell. */
export const CELL_Y_BIAS = 7;
/** Row 7 (flagships) is at this X, and each row below is 12 pixels lower. */
export const ROW_BASE_X = 0x7c;
export const ROW_PITCH_X = 12;

// ------------------------------------------------------------ decision making

/**
 * How far ahead to predict.
 *
 * Chosen by reachability rather than taste: at one pixel a frame the ship
 * crosses 96 px in this time, nearly half the 211 px playfield, so a threat
 * further out than this can be answered later with room to spare.
 */
export const HORIZON_FRAMES = 96;

/** Threat slots preallocated: 14 bullets plus 7 flyable alien records. */
export const MAX_THREATS = 21;

/**
 * Score weights. `tDeath` is multiplied by enough to dominate every other term
 * combined, so survival is strictly first and the rest only break ties -- which
 * is what stops the weights below needing careful tuning.
 */
export const W_SURVIVAL = 1000;
export const W_ROOM = 4;
export const W_CLEAR = 2;
export const W_SHOOT_RISK = 80;
export const W_COST = 3;
export const W_HOLD = 30;

/**
 * Past this much clearance from the walls, more room buys nothing.
 *
 * The cap is the interesting part: it makes the score flat across the middle of
 * the screen, so the ship walks off a wall but has no reason to cross the
 * middle, which is what stops it cruising to dead centre and dithering there.
 */
export const ROOM_CAP = 48;
export const CLEAR_CAP = 24;

/** A new target must beat the held one by this much, and more to reverse. */
export const HOLD_MARGIN = 30;
export const REVERSE_MARGIN = 30;

/** Within this distance of the target, treat it as arrived and stop moving. */
export const ARRIVED_TOLERANCE = 1;
