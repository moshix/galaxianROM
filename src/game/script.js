/**
 * The frame handler and the SCRIPT state machine.
 *
 * Galaxian is entirely script-driven. SCRIPT_NUMBER selects one of five
 * programs -- power-on, attract, awaiting start, player one, player two -- and
 * SCRIPT_STAGE indexes a table of subroutines within it. Each stage does a
 * slice of work and bumps SCRIPT_STAGE when it is finished, which is how the
 * game sequences screens without a scheduler.
 *
 * Everything here runs from the vblank NMI at 60.606 Hz.
 *
 * @see reference/galaxian.asm:196-216 (the script concept, in Tunstall's words)
 * @see reference/galaxian.asm:786-857 (the NMI handler)
 * @see reference/galaxian.asm:2040-2100 (HANDLE_MAIN_GAME_LOGIC)
 */

import { VAR, BLOCK, PORT, INFLIGHT_ALIEN } from '../machine/addresses.js';
import {
  PACKED_DEFAULT_SWARM, DEFAULT_PLAYER_STATE, DEFAULT_PLAYER_BLOCK, BONUS_GALIXIP_TABLE,
  ALIEN_ATTACK_COUNTER_DEFAULTS, COLOUR_ATTRIBUTE_TABLE_1, COLOUR_ATTRIBUTE_TABLE_2,
  COLOUR_ATTRIBUTE_TABLE_3, CONVOY_FLAGSHIP_SCORE_CHARS, CONVOY_ALIEN_SCORE_CHARS,
} from './tables.js';
import {
  handleSwarmMovement, setAlienPresenceFlags, unpackAlienSwarm, packAlienSwarm,
  setSwarmScrollOffset,
} from './swarm.js';
import { queueCommand, processCommandQueue, resetCommandQueue, CMD } from './commands.js';
import { printText, handleTextScroll, resetTextScroll, TEXT_ERASE } from './text.js';
import {
  updatePlayerScore, resetScore, displayScore, displayShipsRemaining, SCORE,
} from './score.js';
import { putChar, BLANK } from './plot.js';
import * as player from './player.js';
import * as bullets from './bullets.js';
import * as collision from './collision.js';
import * as attack from './attack.js';
import * as inflight from './inflight.js';
import { handleSound, handleSwarmSound, resetSound } from './sound.js';
import {
  drawAlienCommand, deleteAlienCommand, handleSwarmAnimation,
} from './aliendraw.js';

/** Parameters of the BOTTOM_OF_SCREEN command. @see reference/galaxian.asm:8061 */
const BOTTOM = { LEVEL_FLAGS: 0, CREDIT: 1, BONUS_FOR: 2, SHIPS: 3 };

/** Wire the collision and player modules' command hooks to the real queue. */
player.setQueueCommand(queueCommand);
collision.setQueueCommand(queueCommand);

// ---------------------------------------------------------------- per frame

/**
 * One vblank NMI.
 *
 * Order matters. The sprite back buffer is copied to hardware *first*, before
 * any logic runs, which is why what the player sees lags the simulation by one
 * frame. Then the input ports are sampled and shifted through their history
 * (the game needs three frames of $6000 for coin edge detection), the free
 * running TIMING_VARIABLE is decremented, and only then does the script run.
 *
 * @param {import('../machine/machine.js').Machine} m
 */
export function nmi(m) {
  m.blitBackBuffer();

  // Shift the port history. $6000 is kept three deep for coin edge detection.
  m.poke(VAR.PREV_PREV_PREV_STATE_6000, m.peek(VAR.PREV_PREV_PORT_STATE_6000));
  m.poke(VAR.PREV_PREV_PORT_STATE_6000, m.peek(VAR.PREV_PORT_STATE_6000));
  m.poke(VAR.PREV_PORT_STATE_6000, m.peek(VAR.PORT_STATE_6000));
  m.poke(VAR.PREV_PORT_STATE_6800, m.peek(VAR.PORT_STATE_6800));
  m.poke(VAR.PORT_STATE_7000, m.readDips());
  m.poke(VAR.PORT_STATE_6800, m.port6800);
  m.poke(VAR.PORT_STATE_6000, m.port6000);

  m.poke(VAR.TIMING_VARIABLE, (m.peek(VAR.TIMING_VARIABLE) - 1) & 0xff);

  checkIfCoinInserted(m);
  handleUnprocessedCoins(m);
  handleSound(m);
  handleSwarmSound(m);
  handleTextScroll(m);

  runScript(m);

  // The foreground loop drains whatever this frame queued, and animates the
  // swarm whenever it finds the queue empty.
  processCommandQueue(m, COMMAND_HANDLERS, handleSwarmAnimation);
}

/** Command handlers, in the order of the jump table at $203D. */
const COMMAND_HANDLERS = {
  [CMD.DRAW_ALIEN]: (m, p) => drawAlienCommand(m, p),
  [CMD.DELETE_ALIEN]: (m, p) => deleteAlienCommand(m, p),
  [CMD.DISPLAY_PLAYER]: (m, p) => displayPlayerCommand(m, p),
  [CMD.UPDATE_SCORE]: (m, p) => updatePlayerScore(m, p),
  [CMD.RESET_SCORE]: (m, p) => resetScore(m, p),
  [CMD.DISPLAY_SCORE]: (m, p) => displayScore(m, p),
  [CMD.PRINT_TEXT]: (m, p) => printText(m, p),
  [CMD.BOTTOM_OF_SCREEN]: (m, p) => displayBottomOfScreen(m, p),
};

/**
 * HANDLE_MAIN_GAME_LOGIC ($0661).
 *
 * Twenty-seven subsystem calls in a fixed order, every frame. The order is
 * load-bearing: collision runs after movement but before the bullet is
 * re-armed, so a kill this frame frees the shot next frame; and the attack
 * counters tick after the attack decision, not before.
 *
 * @see reference/galaxian.asm:2041-2067
 * @param {import('../machine/machine.js').Machine} m
 */
export function mainGameLogic(m) {
  const hooks = { trySpawnEnemyBullet: bullets.trySpawnEnemyBullet };

  player.handlePlayerMove(m);
  bullets.handlePlayerBullet(m);
  bullets.handleEnemyBullets(m);
  inflight.handleInflightAliens(m, hooks);
  inflight.handleInflightAlienSpriteUpdate(m);
  player.handlePlayerShoot(m);
  collision.handleSwarmAlienToPlayerBulletCollisionDetection(m);
  collision.handlePlayerToEnemyBulletCollisionDetection(m);
  collision.handleInflightAlienToPlayerBulletCollisionDetection(m);
  collision.handlePlayerToInflightAlienCollisionDetection(m);
  bullets.checkIfPlayerBulletExpired(m);
  attack.handleFlagshipAttack(m);
  attack.handleSingleAlienAttack(m);
  attack.setAlienAttackFlank(m);
  attack.handleLevelDifficulty(m);
  player.handlePlayerHit(m);
  player.handlePlayerDying(m);
  // $16A6 only decays the alien death sound counter.
  decayAlienDeathSound(m);
  attack.checkIfAlienCanAttack(m);
  attack.updateAttackCounters(m);
  attack.checkIfFlagshipCanAttack(m);
  attack.handleCalcInflightAlienShootingDistance(m);
  checkIfLevelIsComplete(m);
  handleLevelComplete(m);
  attack.handleAlienAggressiveness(m);
  attack.handleShockedSwarm(m);
  simulatePlayerInAttractMode(m);

  // The tail at $06B2: once the player, the bullet, every alien and every
  // enemy shot are gone, count down and move to the next stage.
  if ((m.peek(VAR.HAS_PLAYER_BULLET_BEEN_FIRED)
    | m.peek(VAR.HAS_PLAYER_SPAWNED)
    | m.peek(VAR.IS_PLAYER_DYING)) & 1) return;
  if ((m.peek(VAR.HAVE_NO_INFLIGHT_OR_DYING_ALIENS) & 1) === 0) return;
  for (let i = 0; i < 14; i += 1) {
    if (m.peek(BLOCK.ENEMY_BULLETS.addr + i * 5) & 1) return;
  }
  const counter = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_2, counter);
  if (counter === 0) bumpStage(m);
}

// ------------------------------------------------------------ script driver

/**
 * Dispatch the current script. SCRIPT_THREE and SCRIPT_FOUR run the swarm
 * routines before their stage, which is why those two always animate.
 * @param {import('../machine/machine.js').Machine} m
 */
function runScript(m) {
  const script = m.peek(VAR.SCRIPT_NUMBER);
  const stage = m.peek(VAR.SCRIPT_STAGE);
  switch (script) {
    case 0: scriptZero(m); break;
    case 1:
      handleSwarmMovement(m);
      setAlienPresenceFlags(m);
      scriptOne(m, stage);
      attractTail(m);
      break;
    case 2:
      handleSwarmMovement(m);
      setAlienPresenceFlags(m);
      scriptTwo(m, stage);
      handleStartButtons(m);
      break;
    case 3:
    case 4:
      handleSwarmMovement(m);
      setAlienPresenceFlags(m);
      gameStage(m, stage, script);
      break;
    default: break;
  }
}

/** @param {import('../machine/machine.js').Machine} m */
const bumpStage = (m) => m.poke(VAR.SCRIPT_STAGE, (m.peek(VAR.SCRIPT_STAGE) + 1) & 0xff);

/**
 * WAIT_FOR_TEMP_COUNTERS ($0336): counter 1 ticks every frame and reloads at
 * 60, counter 2 ticks once per reload. @see reference/galaxian.asm:1318-1324
 * @param {import('../machine/machine.js').Machine} m
 * @returns {boolean} true when both have expired
 */
function waitForTempCounters(m) {
  const c1 = (m.peek(VAR.TEMP_COUNTER_1) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_1, c1);
  if (c1 !== 0) return false;
  m.poke(VAR.TEMP_COUNTER_1, 0x3c);
  const c2 = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_2, c2);
  return c2 === 0;
}

/** WAIT_FOR_TEMP_COUNTER_2 ($032E). @param {import('../machine/machine.js').Machine} m */
function waitForCounter2(m) {
  const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_2, c);
  if (c === 0) bumpStage(m);
}

/**
 * The NAMCO logo sits in character RAM column 28 ($527C & $1F), so $4058 is
 * that column's scroll register in the OBJRAM back buffer. The attract script
 * zeroes it by hand at $0263 and $027B.
 */
const NAMCO_SCROLL_ATTR = BLOCK.OBJRAM_BACK_BUF.addr + (0x527c & 0x1f) * 2;

/**
 * HANDLE_ALIEN_SWARM_SCROLL_RESET ($0363). Every frame of the four points-table
 * stages puts the nine swarm columns back to scroll offset zero. The swarm
 * scrolled those columns while it was on screen, and WE ARE THE GALAXIANS and
 * MISSION: DESTROY ALIENS are printed into two of them -- without this they
 * come out shifted sideways and clipped at the edge of the screen.
 * @param {import('../machine/machine.js').Machine} m
 */
function resetSwarmScroll(m) {
  setSwarmScrollOffset(m, 0);
}

// ------------------------------------------------- CONVOY CHARGER fly-on

/** First character cell of the points column. @see reference/galaxian.asm:1553 */
const CONVOY_POINTS_ADDR = 0x5193;

/**
 * DRAW_3_CHARACTERS ($03AF). Three characters up the same tilemap column, which
 * is a horizontal run on the rotated screen.
 *
 * The pointer arithmetic is deliberately 8-bit: the ROM subtracts $20 from
 * **E** alone and then adds $62 back to it, so the address wraps inside its own
 * 256-byte page rather than borrowing into D. Doing this with a 16-bit add
 * would walk into the wrong page after the third caption.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {readonly number[]} table
 * @param {number} offset first of three characters
 * @param {number} addr character RAM address
 * @returns {number} the address the next caption starts at
 */
function drawThreeCharacters(m, table, offset, addr) {
  let low = addr & 0xff;
  const high = addr & 0xff00;
  for (let i = 0; i < 3; i += 1) {
    putChar(m, high | low, table[offset + i] & 0xff);
    low = (low - 0x20) & 0xff;
  }
  return high | ((low + 0x62) & 0xff);
}

/**
 * CLEAR_DEMO_CONVOY_CHARGER_POINTS ($03C0). Blanks every caption drawn so far.
 *
 * Note the asymmetry with the drawing routine: stepping between the three
 * characters here is a real 16-bit `add hl,de`, so it *can* borrow into the
 * high byte, while the step to the next caption is 8-bit like the one above.
 * Both are reproduced as written.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} count captions to erase
 * @returns {void}
 */
function clearConvoyChargerPoints(m, count) {
  let addr = CONVOY_POINTS_ADDR;
  for (let n = 0; n < count; n += 1) {
    for (let i = 0; i < 3; i += 1) {
      putChar(m, addr, BLANK);
      addr = (addr - 32) & 0xffff;
    }
    addr = (addr & 0xff00) | ((addr + 0x62) & 0xff);
  }
}

/**
 * HANDLE_DRAW_CONVOY_CHARGER_POINTS ($0367).
 *
 * The points beside each example alien blink, and the blink is not a timer of
 * its own -- it is two positions of the free-running TIMING_VARIABLE. The low
 * six bits hitting zero erases the captions and hitting exactly $20 redraws
 * them, so they are on for 32 frames and off for 32.
 *
 * The flagship's value cycles 150/200/300/800 because the table index comes
 * from the *top* two bits of that same counter.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @returns {void}
 */
function handleDrawConvoyChargerPoints(m) {
  // $0367-$036D: nothing to draw until the second alien has been started.
  const scrollId = m.peek(VAR.ATTRACT_MODE_SCROLL_ID);
  if (scrollId === 0 || ((scrollId - 1) & 0xff) === 0) return;

  let remaining = (scrollId - 1) & 0xff;
  const timing = m.peek(VAR.TIMING_VARIABLE);
  const phase = timing & 0x3f;
  if (phase === 0) { clearConvoyChargerPoints(m, remaining); return; }
  if (phase !== 0x20) return;

  // $037A-$0381: two `rlca`s then `and 3` lifts bits 6-7 down into bits 0-1.
  const index = ((timing >> 6) & 3) * 3;
  let addr = drawThreeCharacters(m, CONVOY_FLAGSHIP_SCORE_CHARS, index, CONVOY_POINTS_ADDR);
  remaining = (remaining - 1) & 0xff;
  if (remaining === 0) return;

  // The alien values do not cycle; successive captions read successive rows.
  for (let i = 0; remaining !== 0; i += 1, remaining = (remaining - 1) & 0xff) {
    addr = drawThreeCharacters(m, CONVOY_ALIEN_SCORE_CHARS, i * 3, addr);
  }
}

/**
 * INIT_CONVOY_CHARGER_SPRITE ($0341).
 *
 * Seeds one INFLIGHT_ALIEN record so the ordinary in-flight state machine
 * flies an example alien onto the points page. Nothing here moves a sprite --
 * it sets StageOfLife to 13 and lets `inflight.js` do the rest, which is why
 * the fly-on needed only its two callers rather than any new flight code.
 *
 * The slot is picked from TEMP_COUNTER_2, which counts 4 down to 1 as the page
 * fills: flagship, red, purple, blue.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @returns {void}
 */
function initConvoyChargerSprite(m) {
  const index = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
  // $0345-$0347: three `rrca`s multiply by 32, the size of one record.
  const addr = (0x4330 + ((index << 5) & 0xff)) & 0xffff;
  m.poke(addr + INFLIGHT_ALIEN.IS_ACTIVE, 1);
  m.poke(addr + INFLIGHT_ALIEN.IS_DYING, 0);
  m.poke(addr + INFLIGHT_ALIEN.STAGE_OF_LIFE, 0x0d);
  m.poke(addr + INFLIGHT_ALIEN.Y, 0);
  m.poke(addr + INFLIGHT_ALIEN.ANIMATION_FRAME, 0x0c);
  m.poke(addr + INFLIGHT_ALIEN.INDEX_IN_SWARM, index);
}

/**
 * The four calls every CONVOY CHARGER stage opens with, identically: $023F,
 * $0267 and $028E all begin `call $0363 / $0BBE / $0CC3 / $0367`.
 *
 * The swarm scroll reset is not optional on any of them. It looks redundant on
 * the NAMCO stage, by which point the swarm is long gone -- but the example
 * aliens flying onto this page are in-flight aliens, and the sprite update
 * moves the very columns the reset puts back.
 *
 * @param {import('../machine/machine.js').Machine} m
 * @returns {void}
 */
function convoyChargerFrame(m) {
  resetSwarmScroll(m);
  inflight.handleInflightAlienSpriteUpdate(m);
  inflight.handleInflightAliens(m, { trySpawnEnemyBullet: bullets.trySpawnEnemyBullet });
  handleDrawConvoyChargerPoints(m);
}

/** ATTRACT_MODE_SCROLL_ID++ ($025A, $0287). @param {import('../machine/machine.js').Machine} m */
function bumpScrollId(m) {
  m.poke(VAR.ATTRACT_MODE_SCROLL_ID, (m.peek(VAR.ATTRACT_MODE_SCROLL_ID) + 1) & 0xff);
}

/** SET_COLOUR_ATTRIBUTES ($0598). @param {import('../machine/machine.js').Machine} m */
function setColourAttributes(m, table) {
  for (let column = 0; column < 32; column += 1) {
    m.poke(0x4021 + column * 2, table[column]);
  }
}

/** Blank one 32-character row and advance TEMP_CHAR_RAM_PTR. */
function clearRow(m, count = 0x20) {
  let addr = m.peek16(VAR.TEMP_CHAR_RAM_PTR);
  for (let i = 0; i < count; i += 1) { putChar(m, addr, BLANK); addr += 1; }
  m.poke16(VAR.TEMP_CHAR_RAM_PTR, addr & 0xffff);
}

// ------------------------------------------------------------- SCRIPT_ZERO

/**
 * SCRIPT_ZERO ($00E6). Wipes the screen a row at a time, then latches the dip
 * switches and hands over to attract mode.
 * @see reference/galaxian.asm:860-924
 * @param {import('../machine/machine.js').Machine} m
 */
function scriptZero(m) {
  clearRow(m);
  const counter = (m.peek(VAR.TEMP_COUNTER_1) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_1, counter);
  if (counter !== 0) return;

  m.poke(VAR.IS_GAME_OVER, 1);
  m.poke(VAR.IS_GAME_IN_PLAY, 0);
  m.poke(VAR.SCRIPT_NUMBER, 1);
  m.poke(VAR.SCRIPT_STAGE, 0);

  // Latch the dip switches once, here, for the rest of the session.
  m.poke(VAR.DIP_SWITCH_1_2_STATE, (m.peek(VAR.PORT_STATE_6800) >> 6) & 3);
  m.poke(VAR.DIP_SWITCH_5_STATE, (m.peek(VAR.PORT_STATE_7000) & 4) >> 2);
  unpackAlienSwarm(m, PACKED_DEFAULT_SWARM);
  m.poke(VAR.IS_COCKTAIL, (m.peek(VAR.PORT_STATE_6000) & 0x20) >> 5);
  m.poke(VAR.BONUS_GALIXIP_FOR, BONUS_GALIXIP_TABLE[m.readDips() & 3]);

  setColourAttributes(m, COLOUR_ATTRIBUTE_TABLE_1);
  putChar(m, 0x5340, 0x01); // "1"
  putChar(m, 0x5320, 0x25); // "U"
  putChar(m, 0x5300, 0x20); // "P"
  queueCommand(m, CMD.PRINT_TEXT, 4);      // HIGH SCORE
  queueCommand(m, CMD.DISPLAY_SCORE, SCORE.ALL);
}

// -------------------------------------------------------------- SCRIPT_ONE

/**
 * SCRIPT_ONE ($0156), attract mode. Nineteen stages that cycle the GAME OVER
 * screen, the WE ARE THE GALAXIANS intro, the points table, and a demo game.
 * @see reference/galaxian.asm:936-1514
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} stage
 */
function scriptOne(m, stage) {
  switch (stage) {
    case 0: // DISPLAY_GAME_OVER_AND_REMAINING_CREDIT_1 ($018C)
      queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.CREDIT);
      queueCommand(m, CMD.PRINT_TEXT, 0); // GAME OVER
      m.poke(VAR.IS_GAME_OVER, 1);
      m.write(PORT.STARS_ENABLE, 1);
      bumpStage(m);
      m.poke(VAR.PUSH_START_BUTTON_COUNTER, 0);
      m.poke(VAR.CURRENT_PLAYER, 0);
      m.poke(VAR.IS_TWO_PLAYER_GAME, 0);
      m.poke(VAR.IS_GAME_IN_PLAY, 0);
      m.poke(VAR.TEMP_COUNTER_1, 0x60);
      m.poke(VAR.TEMP_COUNTER_2, 0x10);
      break;
    case 1: // SET_PUSH_START_BUTTON_COUNTER ($01BE)
      m.poke(VAR.PUSH_START_BUTTON_COUNTER, 1);
      if (waitForTempCounters(m)) bumpStage(m);
      break;
    case 2: // HIDE_SWARM_AND_PREPARE_TO_CLEAR_SCREEN ($01C6)
    case 8:
      for (let i = 0; i < 0x80; i += 1) m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + i, 0);
      m.poke(VAR.TIMING_VARIABLE, 0);
      m.poke(VAR.HAVE_AGGRESSIVE_ALIENS, 0);
      m.poke16(VAR.TEMP_CHAR_RAM_PTR, 0x5002);
      m.poke(VAR.TEMP_COUNTER_2, 0x20);
      bumpStage(m);
      break;
    case 3: { // CLEAR_SCREEN_BEFORE_WE_ARE_THE_GALAXIANS_INTRO ($01E1)
      clearRow(m, 0x1c);
      m.poke16(VAR.TEMP_CHAR_RAM_PTR, (m.peek16(VAR.TEMP_CHAR_RAM_PTR) + 4) & 0xffff);
      const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c);
      if (c !== 0) break;
      bumpStage(m);
      m.poke(VAR.TEMP_COUNTER_1, 0x40);
      m.poke(VAR.TEMP_COUNTER_2, 0x04);
      m.poke(VAR.DISABLE_SWARM_ANIMATION, 1);
      // $0212 loads table *3*, not table 2. Table 3 is the only one that puts
      // colour 7 on columns 28 and 29, which is what makes the NAMCO logo
      // magenta; under table 2 those columns are colour 6 and the logo comes
      // out cyan, the same blue as CONVOY CHARGER above it.
      setColourAttributes(m, COLOUR_ATTRIBUTE_TABLE_3);
      break;
    }
    case 4: { // DISPLAY_WE_ARE_THE_GALAXIANS_INTRO ($0218)
      resetSwarmScroll(m);
      const c1 = (m.peek(VAR.TEMP_COUNTER_1) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_1, c1);
      if (c1 !== 0) break;
      m.poke(VAR.TEMP_COUNTER_1, 0x50);
      const c2 = m.peek(VAR.TEMP_COUNTER_2);
      queueCommand(m, CMD.PRINT_TEXT, (c2 + 6) & 0xff);
      const next = (c2 - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, next);
      if (next !== 0) break;
      bumpStage(m);
      m.poke(VAR.TEMP_COUNTER_1, 0x20);
      m.poke(VAR.TEMP_COUNTER_2, 0x04);
      break;
    }
    case 5: { // SCROLL_ON_CONVOY_CHARGER_POINTS ($023F)
      convoyChargerFrame(m);
      // The sprite and points-value scroll this stage performs -- the calls to
      // INIT_CONVOY_CHARGER_SPRITE and HANDLE_DRAW_CONVOY_CHARGER_POINTS -- is
      // not implemented; what is here is the counter structure, which is what
      // times the NAMCO logo. Note the reload is $D2, not the $3C that
      // WAIT_FOR_TEMP_COUNTERS uses, so this page dwells ~660 frames.
      const c1 = (m.peek(VAR.TEMP_COUNTER_1) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_1, c1);
      if (c1 !== 0) break;
      m.poke(VAR.TEMP_COUNTER_1, 0xd2);
      // $0253: start the next example alien flying on, *then* bump the scroll
      // id -- the id is what tells the points routine how many captions to
      // draw, so doing it the other way round draws one caption too early.
      initConvoyChargerSprite(m);
      bumpScrollId(m);
      const c2 = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c2);
      if (c2 !== 0) break;
      // $025E-$0263: hand the NAMCO stage its dwell, and put the logo's column
      // back to scroll offset zero before anything is written into it.
      m.poke(VAR.TEMP_COUNTER_2, 0xd2);
      bumpStage(m);
      m.poke(NAMCO_SCROLL_ATTR, 0);
      break;
    }
    case 6: { // DISPLAY_NAMCO_LOGO ($0267)
      convoyChargerFrame(m);
      // The logo is not queued on entry: $0273-$0277 waits out TEMP_COUNTER_2
      // first and only prints on the frame the stage ends, so the wordmark
      // appears once, whole, after the points table has been up for ~210
      // frames. Queuing it every frame of the stage puts it on screen the
      // moment the stage starts instead.
      const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c);
      if (c !== 0) break;
      bumpStage(m);
      m.poke(NAMCO_SCROLL_ATTR, 0);
      // $027E-$0281: `ld ($4008),hl` writes both counters, L then H.
      m.poke(VAR.TEMP_COUNTER_1, 0x40);
      m.poke(VAR.TEMP_COUNTER_2, 0x11);
      bumpScrollId(m);
      queueCommand(m, CMD.PRINT_TEXT, 0x0f); // NAMCO logo
      break;
    }
    case 7: // BLINK_CONVOY_CHARGER_POINTS ($028E)
      convoyChargerFrame(m);
      if (waitForTempCounters(m)) bumpStage(m);
      break;
    case 9: { // CLEAR_WE_ARE_GALAXIANS_SCREEN_AND_DISPLAY_GAME_OVER ($029D)
      // The same 28-character wipe stage 3 uses, run again to take the points
      // table back down: one tilemap row per frame for the $20 frames stage 8
      // counted out. Columns 0-1 and 30-31 are skipped, which is why the score
      // line and the credit line survive it.
      //
      // Erasing only the two strings this stage is *about* is not enough --
      // SCORE ADVANCE TABLE, CONVOY CHARGER, the points digits and the NAMCO
      // logo are all still on screen, and the demo game's swarm scroll then
      // drags whatever it left behind sideways through the columns it shares.
      resetSwarmScroll(m);
      clearRow(m, 0x1c);
      m.poke16(VAR.TEMP_CHAR_RAM_PTR, (m.peek16(VAR.TEMP_CHAR_RAM_PTR) + 4) & 0xffff);
      const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c);
      if (c !== 0) break;
      bumpStage(m);
      // $02B6: B = 0 means 256, so the whole INFLIGHT_ALIENS array goes.
      for (let i = 0; i < BLOCK.INFLIGHT_ALIENS.size; i += 1) {
        m.poke(BLOCK.INFLIGHT_ALIENS.addr + i, 0);
      }
      // $02BC: sprites *and* bullets -- $40 bytes from $4060, not $20.
      for (let i = 0; i < 0x40; i += 1) m.poke(BLOCK.OBJRAM_BACK_BUF_SPRITES.addr + i, 0);
      m.poke(VAR.TEMP_COUNTER_1, 0x40);
      m.poke(VAR.TEMP_COUNTER_2, 0x04);
      setColourAttributes(m, COLOUR_ATTRIBUTE_TABLE_1);
      queueCommand(m, CMD.PRINT_TEXT, 0); // GAME OVER
      break;
    }
    case 10: // DISPLAY_GAME_OVER_AND_REMAINING_CREDIT_2 ($02D1)
      queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.CREDIT);
      queueCommand(m, CMD.PRINT_TEXT, 0); // GAME OVER
      bumpStage(m);
      m.poke(VAR.TEMP_COUNTER_1, 0x60);
      m.poke(VAR.TEMP_COUNTER_2, 0x10);
      break;
    case 11: // WAIT_FOR_TEMP_COUNTER_2_THEN_ADVANCE_TO_NEXT_STAGE ($032E)
      waitForCounter2(m);
      break;
    case 12: // CLEAR_ALIEN_SWARM_AND_SUSPEND_SWARM_ANIMATION ($02E8)
      for (let i = 0; i < 0x80; i += 1) m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + i, 0);
      m.poke(VAR.DISABLE_SWARM_ANIMATION, 1);
      m.poke(VAR.TEMP_COUNTER_2, 0x40);
      bumpStage(m);
      break;
    case 13: // CREATE_ATTRACT_MODE_ALIEN_SWARM ($02FD)
      startDemoGame(m);
      break;
    case 14: player.handleSpawnPlayer(m); break;
    case 15: mainGameLogic(m); break;
    case 16: // HANDLE_PLAYER_ONE_KILLED, demo variant
      m.poke(VAR.SCRIPT_STAGE, 0x0e);
      m.poke(VAR.TEMP_COUNTER_2, 0x50);
      break;
    case 17: waitForCounter2(m); break;
    default: // 18: SET_SCRIPT_STAGE_TO_1 ($0322)
      m.poke(VAR.SCRIPT_STAGE, 1);
      m.poke(VAR.TEMP_COUNTER_1, 3);
      m.poke(VAR.TEMP_COUNTER_2, 3);
      break;
  }
}

/** Set up the demo game the attract mode plays. @see reference/galaxian.asm:1261-1286 */
function startDemoGame(m) {
  unpackAlienSwarm(m, PACKED_DEFAULT_SWARM);
  for (let i = 0; i < 8; i += 1) {
    m.poke(BLOCK.CURRENT_PLAYER_STATE.addr + i, DEFAULT_PLAYER_STATE[i]);
  }
  m.poke(VAR.PLAYER_LIVES, 1);
  m.poke(VAR.DISABLE_SWARM_ANIMATION, 0);
  m.poke(VAR.IS_GAME_IN_PLAY, 0);
  m.poke(VAR.TIMING_VARIABLE, 0);
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1, 0x40);
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, 0x06);
  m.poke16(VAR.SWARM_SCROLL_VALUE, 0x0001);
  m.poke(VAR.TEMP_COUNTER_2, 0x96);
  bumpStage(m);
}

/**
 * The tail of SCRIPT_ONE at $03D7: a credit moves the game on to SCRIPT_TWO.
 * @param {import('../machine/machine.js').Machine} m
 */
function attractTail(m) {
  if (m.peek(VAR.NUM_CREDITS) === 0) return;
  m.poke(VAR.SCRIPT_NUMBER, 2);
  m.poke(VAR.SCRIPT_STAGE, 0);
  m.poke(VAR.IS_GAME_OVER, 0);
  m.poke(VAR.ENABLE_ALIEN_ATTACK_SOUND, 0);
  m.poke(VAR.IS_COLUMN_SCROLLING, 0);
  resetTextScroll(m);
}

// -------------------------------------------------------------- SCRIPT_TWO

/**
 * SCRIPT_TWO ($03F2). A credit is in; wait for a start button.
 * @see reference/galaxian.asm:1524-1660
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} stage
 */
function scriptTwo(m, stage) {
  switch (stage) {
    case 0: // INIT_0408
      setColourAttributes(m, COLOUR_ATTRIBUTE_TABLE_2);
      for (let a = 0x4060; a <= 0x409f; a += 1) m.poke(a, 0);
      for (let a = 0x4260; a <= 0x43af; a += 1) m.poke(a, 0);
      m.poke(VAR.DISABLE_SWARM_ANIMATION, 0);
      m.poke(VAR.IS_COLUMN_SCROLLING, 0);
      m.poke16(VAR.TEMP_CHAR_RAM_PTR, 0x5002);
      m.poke(VAR.TEMP_COUNTER_2, 0x10);
      bumpStage(m);
      break;
    case 1: { // WAIT_BEFORE_DISPLAYING_PUSH_START_BUTTON
      const c = (m.peek(VAR.PUSH_START_BUTTON_COUNTER) - 1) & 0xff;
      m.poke(VAR.PUSH_START_BUTTON_COUNTER, c);
      if (c !== 0) break;
      bumpStage(m);
      for (let i = 0; i < 0x80; i += 1) m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + i, 0);
      break;
    }
    case 2: { // DISPLAY_PUSH_START_BUTTON_AND_BONUS_GALIXIP_FOR ($0443)
      // Two rows of 28 per frame, each followed by a 4 character step to reach
      // the start of the next row.
      for (let i = 0; i < 2; i += 1) {
        clearRow(m, 0x1c);
        m.poke16(VAR.TEMP_CHAR_RAM_PTR, (m.peek16(VAR.TEMP_CHAR_RAM_PTR) + 4) & 0xffff);
      }
      const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c);
      if (c !== 0) break;
      m.write(PORT.HFLIP, 0);
      m.write(PORT.VFLIP, 0);
      m.poke(VAR.DISPLAY_IS_COCKTAIL_P2, 0);
      queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.BONUS_FOR);
      queueCommand(m, CMD.PRINT_TEXT, 1); // PUSH START BUTTON
      bumpStage(m);
      break;
    }
    default: { // BLINK_LAMPS_IF_CREDIT_INSERTED
      const on = (m.peek(VAR.TIMING_VARIABLE) & 0x20) !== 0 && m.peek(VAR.NUM_CREDITS) > 0;
      m.write(PORT.DRIVER_BASE, on ? 1 : 0);
      m.write(PORT.DRIVER_BASE + 1, on ? 1 : 0);
      break;
    }
  }
}

/**
 * HANDLE_START_BUTTONS ($0492).
 * @see reference/galaxian.asm:1665-1740
 * @param {import('../machine/machine.js').Machine} m
 */
function handleStartButtons(m) {
  const buttons = m.peek(VAR.PORT_STATE_6800);
  const wantsTwoPlayer = (buttons & 2) !== 0;
  const wantsOnePlayer = (buttons & 1) !== 0;
  if (!wantsOnePlayer && !wantsTwoPlayer) return;

  const credits = m.peek(VAR.NUM_CREDITS);
  if (wantsOnePlayer) {
    if (credits === 0) { m.poke(VAR.SCRIPT_NUMBER, 1); return; }
    m.poke(VAR.NUM_CREDITS, credits - 1);
    for (let i = 0; i < 0x20; i += 1) m.poke(BLOCK.PLAYER_TWO_PACKED_SWARM_DEF.addr + i, 0);
    m.poke(VAR.CURRENT_PLAYER, 0);
    m.poke(VAR.IS_TWO_PLAYER_GAME, 0);
  } else {
    if (credits < 2) return;
    m.poke(VAR.NUM_CREDITS, credits - 2);
    // One 32 byte copy, exactly as $04A6 does -- it sweeps up eight bytes past
    // the end of the player state, and the port copies them too.
    for (let i = 0; i < 32; i += 1) {
      m.poke(BLOCK.PLAYER_TWO_PACKED_SWARM_DEF.addr + i, DEFAULT_PLAYER_BLOCK[i]);
    }
    if (m.peek(VAR.DIP_SWITCH_5_STATE)) m.poke(BLOCK.PLAYER_TWO_STATE.addr + 5, 3);
    m.poke(VAR.CURRENT_PLAYER, 0);
    m.poke(VAR.IS_TWO_PLAYER_GAME, 1);
  }

  for (let i = 0; i < 32; i += 1) {
    m.poke(BLOCK.PLAYER_ONE_PACKED_SWARM_DEF.addr + i, DEFAULT_PLAYER_BLOCK[i]);
  }
  if (m.peek(VAR.DIP_SWITCH_5_STATE)) m.poke(BLOCK.PLAYER_ONE_STATE.addr + 5, 3);

  m.poke(VAR.SCRIPT_STAGE, 0);
  m.poke(VAR.SCRIPT_NUMBER, 3);
  m.poke(VAR.IS_GAME_IN_PLAY, 1);
  m.poke(VAR.PLAY_GAME_START_MELODY, 1);
  queueCommand(m, CMD.PRINT_TEXT, 4);
  queueCommand(m, CMD.RESET_SCORE, SCORE.PLAYER_ONE);
  queueCommand(m, CMD.RESET_SCORE, SCORE.PLAYER_TWO);
}

// ------------------------------------------------------ SCRIPT_THREE / FOUR

/**
 * The eight stages shared by both players' scripts.
 * @see reference/galaxian.asm:1783 (player one), 2257 (player two)
 * @param {import('../machine/machine.js').Machine} m
 * @param {number} stage
 * @param {number} script 3 or 4
 */
function gameStage(m, stage, script) {
  switch (stage) {
    case 0: resetForNewTurn(m); break;
    case 1: { // CLEAR_ROW_OF_SCREEN ($0583)
      clearRow(m);
      const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c);
      if (c !== 0) break;
      bumpStage(m);
      // The routine does not return here: it falls straight through into
      // SET_COLOUR_ATTRIBUTES_TABLE_1 at $0595, so finishing the screen wipe
      // also restores the in-game palette. Neither written spec mentions it.
      setColourAttributes(m, COLOUR_ATTRIBUTE_TABLE_1);
      break;
    }
    case 2: playerInit(m, script); break;
    case 3: { // CLEAR_PLAYER_TEXT ($0605)
      // "PLAYER ONE" sits on screen for 150 frames before the wave begins.
      const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
      m.poke(VAR.TEMP_COUNTER_2, c);
      if (c !== 0) break;
      m.poke(VAR.TEMP_COUNTER_2, 0x14);
      bumpStage(m);
      // Both players' labels occupy the same cells, so erasing index 2 clears
      // either one. @see reference/galaxian.asm:1929
      queueCommand(m, CMD.PRINT_TEXT, 2 | TEXT_ERASE);
      break;
    }
    case 4: player.handleSpawnPlayer(m); break;
    case 5: mainGameLogic(m); break;
    case 6: playerKilled(m, script); break;
    default: switchPlayer(m, script); break;
  }
}

/** SCRIPT_THREE stage 0 ($0550). @param {import('../machine/machine.js').Machine} m */
function resetForNewTurn(m) {
  m.write(PORT.DRIVER_BASE, 0);
  m.write(PORT.DRIVER_BASE + 1, 0);
  for (let i = 0; i < 0x80; i += 1) m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + i, 0);
  m.poke(VAR.TIMING_VARIABLE, 0);
  for (let a = 0x4200; a < 0x4217; a += 1) m.poke(a, 0);
  for (let a = 0x4218; a < 0x4230; a += 1) m.poke(a, 0);
  for (let a = 0x4260; a < 0x42a6; a += 1) m.poke(a, 0);
  m.poke(VAR.HAVE_NO_INFLIGHT_ALIENS, 1);
  bumpStage(m);
  m.poke(VAR.TEMP_COUNTER_2, 0x20);
  m.poke16(VAR.TEMP_CHAR_RAM_PTR, 0x5000);
}

/** PLAYER_ONE_INIT ($05A5) / PLAYER_TWO_INIT ($0795). */
function playerInit(m, script) {
  const isPlayerOne = script === 3;
  const swarmDef = isPlayerOne
    ? BLOCK.PLAYER_ONE_PACKED_SWARM_DEF.addr : BLOCK.PLAYER_TWO_PACKED_SWARM_DEF.addr;
  const stateAddr = isPlayerOne ? BLOCK.PLAYER_ONE_STATE.addr : BLOCK.PLAYER_TWO_STATE.addr;

  const packed = [];
  for (let i = 0; i < 16; i += 1) packed.push(m.peek(swarmDef + i));
  unpackAlienSwarm(m, packed);
  for (let i = 0; i < 8; i += 1) {
    m.poke(BLOCK.CURRENT_PLAYER_STATE.addr + i, m.peek(stateAddr + i));
  }
  m.poke(VAR.TIMING_VARIABLE, 0);
  m.poke(VAR.HAVE_NO_ALIENS_IN_SWARM, 0);
  m.write(PORT.HFLIP, 0);
  m.write(PORT.VFLIP, 0);
  m.poke(VAR.TEMP_COUNTER_2, 0x96);
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_1, isPlayerOne ? 0x40 : 0x30);
  m.poke(VAR.FLAGSHIP_ATTACK_MASTER_COUNTER_2, isPlayerOne ? 0x06 : 0x08);

  bumpStage(m);

  // Nothing is drawn in attract mode; the demo game shares this routine.
  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) return;

  // $05D6-$05F9. A one player game draws only its own score; a two player game
  // draws all three. Both then share the tail from $05E2.
  if (m.peek(VAR.IS_TWO_PLAYER_GAME) & 1) {
    queueCommand(m, CMD.DISPLAY_SCORE, SCORE.ALL);
  } else {
    queueCommand(m, CMD.DISPLAY_SCORE, SCORE.PLAYER_ONE);
  }
  queueCommand(m, CMD.DISPLAY_SCORE, SCORE.HIGH);
  queueCommand(m, CMD.PRINT_TEXT, isPlayerOne ? 2 : 3);
  queueCommand(m, CMD.PRINT_TEXT, 4);
  queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.SHIPS);
  queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.LEVEL_FLAGS);
}

/** HANDLE_PLAYER_ONE_KILLED ($06D8) / _TWO_ ($07E8). */
function playerKilled(m, script) {
  const lives = m.peek(VAR.PLAYER_LIVES);
  const otherAddr = script === 3
    ? BLOCK.PLAYER_TWO_STATE.addr + 5 : BLOCK.PLAYER_ONE_STATE.addr + 5;
  const otherLives = m.peek(otherAddr);
  const twoPlayer = m.peek(VAR.IS_TWO_PLAYER_GAME) !== 0;

  if (lives !== 0) {
    if (twoPlayer && otherLives !== 0) {
      m.poke(VAR.SCRIPT_STAGE, 7);
      m.poke(VAR.TEMP_COUNTER_2, 0x50);
    } else {
      m.poke(VAR.SCRIPT_STAGE, 4);
      m.poke(VAR.TEMP_COUNTER_2, 0x50);
    }
    return;
  }
  if (twoPlayer && otherLives !== 0) {
    m.poke(VAR.SCRIPT_STAGE, 7);
    m.poke(VAR.TEMP_COUNTER_2, 0x82);
    queueCommand(m, CMD.PRINT_TEXT, script === 3 ? 2 : 3);
    queueCommand(m, CMD.PRINT_TEXT, 0);
    return;
  }
  gameOver(m);
}

/** GAME_OVER ($0722). @param {import('../machine/machine.js').Machine} m */
function gameOver(m) {
  m.poke(VAR.SCRIPT_NUMBER, 1);
  m.poke(VAR.IS_GAME_IN_PLAY, 0);
  m.poke(VAR.SCRIPT_STAGE, 0);
  // $0734 -- otherwise the swarm hum carries on into the attract screen.
  resetSound(m);
  queueCommand(m, CMD.PRINT_TEXT, 0);
}

/** SWITCH_TO_PLAYER_TWO ($073D) / SWITCH_TO_PLAYER_ONE ($0818). */
function switchPlayer(m, script) {
  const c = (m.peek(VAR.TEMP_COUNTER_2) - 1) & 0xff;
  m.poke(VAR.TEMP_COUNTER_2, c);
  if (c !== 0) return;

  m.poke(VAR.SCRIPT_STAGE, 0);
  m.poke(VAR.LEVEL_COMPLETE, 0);
  m.poke(VAR.IS_FLAGSHIP_HIT, 0);
  const isPlayerOne = script === 3;
  packAlienSwarm(m, isPlayerOne
    ? BLOCK.PLAYER_ONE_PACKED_SWARM_DEF.addr : BLOCK.PLAYER_TWO_PACKED_SWARM_DEF.addr);
  const stateAddr = isPlayerOne ? BLOCK.PLAYER_ONE_STATE.addr : BLOCK.PLAYER_TWO_STATE.addr;
  for (let i = 0; i < 8; i += 1) {
    m.poke(stateAddr + i, m.peek(BLOCK.CURRENT_PLAYER_STATE.addr + i));
  }
  m.poke(VAR.CURRENT_PLAYER, isPlayerOne ? 1 : 0);
  m.poke(VAR.SCRIPT_NUMBER, isPlayerOne ? 4 : 3);
}

// ------------------------------------------------------------- level flow

/** CHECK_IF_LEVEL_IS_COMPLETE ($1621). */
function checkIfLevelIsComplete(m) {
  if ((m.peek(VAR.HAVE_NO_ALIENS_IN_SWARM) & 1) === 0) return;
  if ((m.peek(VAR.HAVE_NO_INFLIGHT_OR_DYING_ALIENS) & 1) === 0) return;
  if (m.peek(VAR.LEVEL_COMPLETE) !== 0) return;
  m.poke(VAR.LEVEL_COMPLETE, 1);
  m.poke(VAR.NEXT_LEVEL_DELAY_COUNTER, 0);
}

/** HANDLE_LEVEL_COMPLETE ($1637). @see reference/galaxian.asm:5489-5537 */
function handleLevelComplete(m) {
  if (m.peek(VAR.LEVEL_COMPLETE) === 0) return;
  const delay = (m.peek(VAR.NEXT_LEVEL_DELAY_COUNTER) - 1) & 0xff;
  m.poke(VAR.NEXT_LEVEL_DELAY_COUNTER, delay);
  if (delay !== 0) return;

  m.poke(VAR.LEVEL_COMPLETE, 0);
  unpackAlienSwarm(m, PACKED_DEFAULT_SWARM);
  m.poke(VAR.DIFFICULTY_EXTRA_VALUE, 0);
  m.poke(VAR.TIMING_VARIABLE, 0);
  m.poke16(VAR.SWARM_SCROLL_VALUE, 0x0001);
  // $1656-$1663 reads PLAYER_LEVEL and DIFFICULTY_BASE_VALUE as one 16-bit
  // value, bumps the level, and raises the base unless it is already at (or
  // somehow above) the cap of 7.
  const level = (m.peek(VAR.PLAYER_LEVEL) + 1) & 0xff;
  const base = m.peek(VAR.DIFFICULTY_BASE_VALUE);
  if (base > attack.DIFFICULTY_MAX) {
    attack.clampDifficultyLevel(m, level);
  } else {
    m.poke(VAR.DIFFICULTY_BASE_VALUE, base === attack.DIFFICULTY_MAX ? base : base + 1);
    m.poke(VAR.PLAYER_LEVEL, level);
  }
  queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.LEVEL_FLAGS);

  // Flagships that escaped the previous wave rejoin the new one.
  let survivors = m.peek(VAR.FLAGSHIP_SURVIVOR_COUNT);
  if (survivors > 0) {
    m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + 0x77, 1);
    survivors -= 1;
    if (survivors > 0) { m.poke(BLOCK.ALIEN_SWARM_FLAGS.addr + 0x78, 1); survivors = 0; }
    m.poke(VAR.FLAGSHIP_SURVIVOR_COUNT, survivors);
  }
}

// ------------------------------------------------------------- odds and ends

/** $16A6: decay the alien death sound selector by one each frame. */
function decayAlienDeathSound(m) {
  const v = m.peek(VAR.ALIEN_DEATH_SOUND);
  if (v !== 0) m.poke(VAR.ALIEN_DEATH_SOUND, (v - 1) & 0xff);
}

/**
 * CHECK_IF_COIN_INSERTED ($18EF).
 *
 * The edge it looks for is a **release**, not a press: the bit must be clear in
 * this frame and the previous one, and set in the two before that. Holding a
 * coin switch down therefore does nothing until it is let go, which is what
 * debounces a mechanical coin mechanism.
 *
 * @see reference/galaxian.asm:6030-6056
 * @param {import('../machine/machine.js').Machine} m
 */
function checkIfCoinInserted(m) {
  // Free play short-circuits the whole thing and just parks 9 credits.
  if (m.peek(VAR.DIP_SWITCH_1_2_STATE) === 3) {
    m.poke(VAR.COIN_COUNT, 0);
    m.poke(VAR.NUM_CREDITS, 9);
    return;
  }

  const recent = m.peek(VAR.PORT_STATE_6000) | m.peek(VAR.PREV_PORT_STATE_6000);
  const edge = (~recent) & m.peek(VAR.PREV_PREV_PORT_STATE_6000)
    & m.peek(VAR.PREV_PREV_PREV_STATE_6000) & 0xff;

  if ((edge & 0x80) !== 0) { serviceCredit(m); return; }
  const coins = edge & 0x03;
  if (coins === 0) return;

  m.poke(VAR.UNPROCESSED_COINS, (m.peek(VAR.UNPROCESSED_COINS) + 1) & 0xff);
  // Both slots releasing on the same frame counts as two coins.
  if (coins === 0x03) {
    m.poke(VAR.UNPROCESSED_COINS, (m.peek(VAR.UNPROCESSED_COINS) + 1) & 0xff);
  }
}

/** The SERVICE button adds a credit directly ($191E). */
function serviceCredit(m) {
  const credits = m.peek(VAR.NUM_CREDITS);
  if (credits < 0x63) return;
  m.poke(VAR.NUM_CREDITS, (credits + 1) & 0xff);
  m.poke(VAR.PLAY_PLAYER_CREDIT_SOUND, 1);
  queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.CREDIT);
}

/**
 * HANDLE_UNPROCESSED_COINS ($1931). One coin is converted to credits per frame.
 * @see reference/galaxian.asm:6080-6130
 * @param {import('../machine/machine.js').Machine} m
 */
function handleUnprocessedCoins(m) {
  // COIN_CONTROL doubles as a countdown that pulses the coin counter solenoid;
  // while it is non-zero no coin is processed.
  const control = m.peek(VAR.COIN_CONTROL);
  if (control !== 0) {
    m.write(PORT.DRIVER_BASE + 3, ((control >> 3) | (control << 5)) & 0xff);
    m.poke(VAR.COIN_CONTROL, (control - 1) & 0xff);
    return;
  }
  const pending = m.peek(VAR.UNPROCESSED_COINS);
  if (pending === 0) return;
  m.poke(VAR.UNPROCESSED_COINS, (pending - 1) & 0xff);
  m.poke(VAR.COIN_CONTROL, 0x0f);

  const coinage = m.peek(VAR.DIP_SWITCH_1_2_STATE);
  if (coinage === 3) return;           // free play, handled above
  if (coinage === 1) {                 // two coins one play
    if ((m.peek(VAR.COIN_COUNT) & 1) === 0) { m.poke(VAR.COIN_COUNT, 1); return; }
    m.poke(VAR.COIN_COUNT, 0);
    addCredit(m);
    return;
  }
  // One coin two plays adds twice; one coin one play adds once.
  if (coinage === 2) addCredit(m);
  addCredit(m);
}

/** The credit adder at $194F, including the clamp at 99. */
function addCredit(m) {
  const credits = m.peek(VAR.NUM_CREDITS);
  if (credits === 0x63) return;
  if (credits > 0x63) { m.poke(VAR.NUM_CREDITS, 0x63); return; }
  m.poke(VAR.NUM_CREDITS, credits + 1);
  m.poke(VAR.PLAY_PLAYER_CREDIT_SOUND, 1);
  queueCommand(m, CMD.BOTTOM_OF_SCREEN, BOTTOM.CREDIT);
}

/** DISPLAY_BOTTOM_OF_SCREEN ($24B7). @see reference/galaxian.asm:8061-8143 */
function displayBottomOfScreen(m, which) {
  if (which === BOTTOM.SHIPS) {
    // $24C4 is `rst $08` -- ASSERT_NOT_GAME_OVER, which on a game-over pops the
    // caller's return address and abandons the routine. Attract mode holds
    // IS_GAME_OVER set the whole way through, so the demo game never draws a
    // spare-ship row; without this the blanking pass at the tail of
    // DISPLAY_PLAYER_SHIPS_REMAINING wipes the CREDIT line sharing those cells.
    if ((m.peek(VAR.IS_GAME_OVER) & 1) !== 0) return;
    displayShipsRemaining(m, m.peek(VAR.PLAYER_LIVES));
    return;
  }
  if (which === BOTTOM.CREDIT) { displayAvailableCredit(m); return; }
  if (which === BOTTOM.BONUS_FOR) { displayBonusFor(m); return; }
  displayLevelFlags(m);
}

/** DISPLAY_AVAILABLE_CREDIT ($24EB). */
function displayAvailableCredit(m) {
  if (m.peek(VAR.IS_GAME_IN_PLAY) & 1) return;
  if ((m.peek(VAR.PORT_STATE_6800) & 0xc0) === 0xc0) { printText(m, 0x10); return; }
  printText(m, 5); // CREDIT
  let credits = m.peek(VAR.NUM_CREDITS);
  if (credits > 99) credits = 99;
  const tens = Math.floor(credits / 10);
  putChar(m, 0x529f, tens === 0 ? BLANK : tens);
  putChar(m, 0x527f, credits % 10);
}

/** DISPLAY_BONUS_GALIXIP_FOR ($24C8). */
function displayBonusFor(m) {
  const bonus = m.peek(VAR.BONUS_GALIXIP_FOR);
  if (bonus === 0xff) return;
  printText(m, 6);
  putChar(m, 0x5138, bonus & 0x0f);
  const high = (bonus & 0xf0) >> 4;
  putChar(m, 0x5158, high === 0 ? BLANK : high);
}

/** DISPLAY_LEVEL_FLAGS ($2520). @see reference/galaxian.asm:8145-8196 */
function displayLevelFlags(m) {
  if ((m.peek(VAR.IS_GAME_OVER) & 1) !== 0) return;
  if (m.peek(VAR.HAVE_NO_ALIENS_IN_SWARM) & 1) m.poke(VAR.RESET_SWARM_SOUND_TEMPO, 1);

  let level = (m.peek(VAR.PLAYER_LEVEL) + 1) & 0xff;
  if (level >= 0x30) level = 0x30;
  const bcd = (((Math.floor(level / 10)) << 4) | (level % 10)) & 0xff;

  let addr = 0x507e;
  // The ROM leaves C uninitialised when the tens digit is zero; the queue
  // dispatcher happens to leave 14 in it. @see docs/game-rules.md section 7.7
  let cells = 14;
  const tens = (bcd & 0xf0) >> 4;
  if (tens !== 0) {
    cells = 0x10;
    for (let i = 0; i < tens; i += 1) {
      putChar(m, addr, 0x68); putChar(m, addr + 1, 0x69);
      putChar(m, addr + 32, 0x6a); putChar(m, addr + 33, 0x6b);
      addr -= 64;
      cells -= 2;
    }
  }
  for (let i = 0; i < (bcd & 0x0f); i += 1) {
    putChar(m, addr, 0x6c); putChar(m, addr + 32, 0x6d);
    addr -= 32;
    cells -= 1;
  }
  while (cells > 0) { putChar(m, addr, BLANK); putChar(m, addr + 32, BLANK); addr -= 32; cells -= 1; }
}

/** DISPLAY_PLAYER_COMMAND ($215F). @see reference/galaxian.asm:7502-7543 */
function displayPlayerCommand(m, param) {
  if (param === 0) { // DRAW_PLAYER_SHIP
    eraseShip(m);
    putChar(m, 0x51fc, 0x60); putChar(m, 0x51fd, 0x61);
    putChar(m, 0x521c, 0x62); putChar(m, 0x521d, 0x63);
    return;
  }
  if (param === 1) { eraseShip(m); return; }
  // Explosion: base $C0/$D0/$E0/$F0 chosen from the frame index.
  const a = (param - 2) & 0xff;
  const base = ((((~(a * 16)) & 0x30) + 0xc0)) & 0xff;
  for (const [addr, offset] of [[0x51da, 0], [0x51dc, 4], [0x521a, 8], [0x521c, 12]]) {
    const b = (base + offset) & 0xff;
    putChar(m, addr, b); putChar(m, addr + 1, b + 1);
    putChar(m, addr + 32, b + 2); putChar(m, addr + 33, b + 3);
  }
}

/** ERASE_PLAYER_SHIP ($2187): a 4x4 block of blanks. */
function eraseShip(m) {
  let addr = 0x51da;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) putChar(m, addr + col, 0x40);
    addr += 0x20;
  }
}

/** HANDLE_SIMULATE_PLAYER_IN_ATTRACT_MODE ($198E) -- wired by the AI module. */
function simulatePlayerInAttractMode(m) { void m; }

/**
 * Put the machine into the state the ROM reaches after its power-on self test,
 * so a fresh game can start without emulating the diagnostics.
 * @param {import('../machine/machine.js').Machine} m
 */
export function coldStart(m) {
  m.reset();
  resetCommandQueue(m);
  m.poke(VAR.SCRIPT_NUMBER, 0);
  m.poke(VAR.SCRIPT_STAGE, 0);
  m.poke(VAR.TEMP_COUNTER_1, 0x20);
  m.poke16(VAR.TEMP_CHAR_RAM_PTR, 0x5000);
  m.poke(VAR.RAND_NUMBER, 0);
  for (let i = 0; i < 16; i += 1) {
    m.poke(BLOCK.ALIEN_ATTACK_COUNTERS.addr + i, ALIEN_ATTACK_COUNTER_DEFAULTS[i]);
  }
  for (let a = 0x5000; a < 0x5400; a += 1) putChar(m, a, BLANK);
  m.write(PORT.NMI_ENABLE, 1);
}
