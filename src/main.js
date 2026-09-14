/**
 * Bootstrap: owns the canvas, the frame clock and input routing.
 * Copyright 2026 y moshix
 * The clock is deliberately not "one frame per requestAnimationFrame". The
 * original runs at 60.606 Hz (18.432 MHz / (1152 * 264)), which no isplay
 * matches exactly, so we acumulate real elapsed time and run as many
 * whole game frames are necessary. Game logic therefore always advances in discrete
 * 1/60.606 s steps, the same steps the Z80 on NAMCO Galaxian takes
 * regardless of wha the monitor is doing.
 */

import { Machine, GAME_WIDTH, GAME_HEIGHT, FRAME_RATE } from './machine/machine.js';
import { Renderer } from './video/renderer.js';
import { coldStart, nmi } from './game/script.js';
 import { VAR } from './machine/addresses.js';
import { AutoPlayer } from './ai/autoplay.js';
import { InputMux } from './input/mux.js';
import { GamepadInput } from './input/gamepad.js';
import { RemapUI } from './input/remapui.js';
import { SoundEngine } from './audio/sound.js';

/**
 * Displayed in the corner of the page and the single place this is written
 * down. Bump it here when a feature lands, and keep `package.json` in step.
 */
export const VERSION = '0.4';

const FRAME_MS = 1000 / FRAME_RATE;
/** Never try to catch up more than this after a tab has been backgrounded. */
const MAX_CATCHUP_FRAMES = 4;

/** Keyboard to switch mapping. @see reference/galaxian.asm:105-128 */
const KEY_MAP = /** @type {const} */ ({
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'fire',
  Digit5: 'coin1',
   Digit6: 'coin2', /** one more coin insrted??? */ 
  Digit1: 'start1',
  Digit2: 'start2',
});

export class Game {
  /** @param {HTMLCanvasElement} canvas */

  /** moshix remove old code o.3 here */  
  
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    /** instantiate new machine below */
      this.machine = new Machine();
    this.machine.refreshCoinageBits();
    this.renderer = new Renderer();   /** and the rendrer */

    // The renerer draws into a Uint32Array; wrap the same buffer in the
      // Uint8ClampedArray that ImageData wants, so presenting a frame copies nottin

    this.frame = new ImageData(
      new Uint8ClampedArray(this.renderer.pixels.buffer), GAME_WIDTH, GAME_HEIGHT,
    );

    /** Whole game frames elapsed since boot. */
    this.frameCount = 0;
    /** Leftover real time not yet converted into game frames, in ms. */
    this.accumulator = 0;
    /** @type {number | null} */
    this.lastTime = null;
    this.running = false;
    this.aiEnabled = false;
    this.zoom = 2;

      this.ai = new AutoPlayer(this.machine);
    /**
     Keyboard and gamepad both close the same switches, so they go through a
    mux instead of writing the ports directly. Moshix go check out src/input/mux.js
     */
    this.mux = new InputMux((name, down) => this.machine.setInput(name, down));
    this.gamepad = new GamepadInput();
    this.sound = new SoundEngine();

    coldStart(this.machine);
  }

  start() {
    if (this.running) return;
    this.running = true;
     this.lastTime = null; /** take precise time */
    requestAnimationFrame(this.tick);
  }

  stop() { this.running = false; }

  /** @param {number} now milliseconds snce  requestAnimationFrame */
  tick = (now) => {
     if (!this.running) return;
    if (this.lastTime === null) this.lastTime = now;
    this.accumulator += now - this.lastTime;
       this.lastTime = now;

    let due = Math.floor(this.accumulator / FRAME_MS);
    if (due > MAX_CATCHUP_FRAMES) {
             // if  tab was hidden or the machine stalled. Drop the backlog 
      this.accumulator = 0;
      due = 1;
    } else {
      this.accumulator -= due * FRAME_MS;
    }

    for (let i = 0; i < due; i += 1) this.stepFrame();
    if (due > 0) this.render();

    requestAnimationFrame(this.tick);
  };

  /** Advance the simulation by exactly one 1/60.606 s frame. */
  stepFrame() {
    this.frameCount += 1;
    // The AI drives the same three switches a human does, so it has to decide 
      // before the machine reads i inputs.
    if (this.aiEnabled) this.ai.step();
    // Only one of the two drives the controls. The AI clears the switches it
    // owns every frame (autoplay.js), so letting a joystick write the at the
    // same time would just be a fight the AI always wins, not fair....
    else this.mux.setAll('gamepad', this.gamepad.poll());
    // One vblank interrupt: the whole game, including the back buffer blit that
    // makes the display lag the simulation by a frame.
    nmi(this.machine);
        this.renderer.stepStars(this.machine.hFlip);
    this.sound.update(this.machine);
  }

  /** @param {boolean} on */
  setAi(on) {
    this.aiEnabled = on;
    // Hand the controls back cleanly, or the last AI input stays held.

    this.ai.release();
    // The AI has been writing the ports behind the mux's back. Re-assert
    // whatever the player is still physically holding, or a direction they
    // never let go of stays open and the ship sits still.
    
    this.mux.clearSource('gamepad');
     this.mux.invalidate();
    const hint = document.getElementById('hint');
    if (hint !== null) hint.style.opacity = on ? '0.9' : '0.55';
  }


  // here we render 
  render() {
    this.renderer.render(this.machine.charRam, this.machine.objRam, {
      stars: this.machine.starsEnabled,
      flipX: this.machine.hFlip,
      flipY: this.machine.vFlip,
    });
    this.ctx.putImageData(this.frame, 0, 0);
    // Expose progress on the element itself, so a headless browser (and the
    // Playwright suite) can tell a running game from a stalled one without
    // needing script access.
    this.canvas.dataset.frame = String(this.frameCount);
  }

  /** Handy in the console: `galaxian.state()`. @returns {Record<string, number>} */
  state() {
    const m = this.machine;
    return {
      frame: this.frameCount,
        script: m.peek(VAR.SCRIPT_NUMBER),
      stage: m.peek(VAR.SCRIPT_STAGE),
      credits: m.peek(VAR.NUM_CREDITS),  // need also credits....
        lives: m.peek(VAR.PLAYER_LIVES),
      level: m.peek(VAR.PLAYER_LEVEL) + 1,
    };
  }

  /** @param {number} z */
  setZoom(z) {
    this.zoom = Math.max(1, Math.min(6, z));
    this.canvas.style.setProperty('--zoom', String(this.zoom));
  }
}

/** @param {Game} game */
function attachInput(game) {
  /** @param {KeyboardEvent} e @param {boolean} down */
  const handle = (e, down) => {
    if (e.repeat) return;
    // The remap dialog owns the keyboard while it is open, so Tab and Enter
    // reach its buttons instead of flying the ship behind it.
    if (game.remap?.isOpen === true) {
      if (down && e.code === 'KeyG') { game.remap.close(); e.preventDefault(); }
      return;
    }
    const mapped = KEY_MAP[/** @type {keyof typeof KEY_MAP} */ (e.code)];
    if (mapped !== undefined) {
      game.mux.set('keyboard', mapped, down);
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (e.code === 'KeyA') {
      game.setAi(!game.aiEnabled);
      // Starting audio needs a user gesture; this counts as one.
      void game.sound.start();
      e.preventDefault();
    } else if (e.code === 'KeyG') {
      game.remap?.toggle();
      // A keypress is a user activation, which is the only way a pad-only
      // player ever gets audio -- gamepad input does not count as a gesture.
      void game.sound.start();
      e.preventDefault();
    } else if (e.code === 'KeyM') {
      void game.sound.start().then(() => game.sound.toggle());
      e.preventDefault();
    }
    else if (e.code === 'Equal' || e.code === 'NumpadAdd') game.setZoom(game.zoom + 1);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') game.setZoom(game.zoom - 1);
  };
  // Any key is a user gesture, which is what browsers require before audio.
  window.addEventListener('keydown', (e) => { void game.sound.start(); handle(e, true); });
  window.addEventListener('keyup', (e) => handle(e, false));
  // A held key must not stay held once focus leaves the page.
  window.addEventListener('gamepadconnected', () => { game.gamepad.recalibrate(); });
  window.addEventListener('gamepaddisconnected', () => {
    game.gamepad.handleDisconnect();
    // Open only the switches the keyboard is not also holding.
    game.mux.clearSource('gamepad');
  });
           // A stick can be knocked, or unplugged and replaced, while the tab is in the
  // background; re-reading its centre on the way back stops it coming back   stuck hard over.
  window.addEventListener('focus', () => {
    game.gamepad.enabled = true;
    game.gamepad.recalibrate();
  });
  window.addEventListener('blur', () => {
    game.gamepad.enabled = false;
    // The ports are cleared wholesale rather than switch by switch, so tell the
        // mux to forget what it thinks is closed -- otherwise the next press looks
    // like a repeat of one already applied and never reaches the machine.
    game.mux.reset();
    game.machine.port6000 = 0;
      game.machine.port6800 = 0;
    game.machine.refreshCoinageBits();
  });
}

function applyUrlWarmup(game) {
  const params = new URLSearchParams(location.search);
  const frames = Number.parseInt(params.get('frames') ?? '', 10);
  if (!Number.isFinite(frames) || frames <= 0) return;

  const tap = (name, held = 3, released = 12) => {
    game.machine.setInput(name, true);
    for (let i = 0; i < held; i += 1) game.stepFrame();
    game.machine.setInput(name, false);
    for (let i = 0; i < released; i += 1) game.stepFrame();
  };

  const before = Math.min(frames, params.has('coin') ? 240 : frames);
  for (let i = 0; i < before; i += 1) game.stepFrame();
  if (params.has('coin')) tap('coin1');
  if (params.has('start')) tap('start1');
  for (let i = before; i < frames; i += 1) game.stepFrame();
  game.render();
}

function showVersion() {
  const el = document.getElementById('version');
  if (el !== null) el.textContent = `version ${VERSION} \u00b7 code by Moshix`;
}

const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('screen'));
showVersion();

if (canvas !== null) {
  const game = new Game(canvas);
  game.setZoom(2);
  game.remap = new RemapUI(game.gamepad);
  attachInput(game);
  applyUrlWarmup(game);
  game.start();
  // Handy for the headless browser tests and for poking at things in the console.
  Reflect.set(globalThis, 'galaxian', game);
}
