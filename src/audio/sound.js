/**
 * WebAudio synthesis of the Galaxian sound board.
 *
 * The board has no sound CPU: it is discrete analogue circuitry driven by ten
 * latch bits and an eight bit pitch value. src/game/sound.js already writes
 * those exactly as the ROM does, so this module's whole job is to watch the
 * latches once per frame and make a comparable noise.
 *
 * Four voices, matching the hardware:
 *
 *   PITCH       A square tone whose frequency is 1.536 MHz / (256 - pitch),
 *               divided by 8, or by 16 when VOL2 is set. Melodies, the coin
 *               sweep, the extra-life beep and the diving-alien swoop all come
 *               out of this one oscillator, which is why they cut each other
 *               off in the original.
 *   BACKGROUND  Three detuned square tones, enabled one per surviving alien up
 *               to three, all swept by a shared LFO whose rate comes from a
 *               4-bit DAC. This is the swarm hum, and the loudest voice.
 *   FIRE        A short noisy chirp, gated for 8 frames.
 *   HIT         Filtered noise with a slow decay: the player's death.
 *
 * @see docs/video-sound.md section A.9
 * @see reference/galaxian.asm:5667-6026
 */

/** The pitch latch's clock. @see docs/video-sound.md A.9.1 */
const SOUND_CLOCK = 1536000;
/** Galaxian's noise is sampled at 2V, giving it a grainy rather than hissy texture. */
const NOISE_RATE = 7920;

/**
 * The three background tones.
 *
 * MAME's netlist builds these with DISCRETE_555_ASTABLE_**CV** -- 555 astables
 * whose control voltage pin is driven by a shared VCO. That matters: the
 * textbook `f = 1.44 / ((R1 + 2*R2) * C)` only gives the frequency at rest
 * (control voltage sitting at 2/3 Vcc). As the control voltage is pulled down,
 * the charge time collapses while the discharge time does not, and the tone
 * climbs by nearly an octave:
 *
 *     t_high = (R1 + R2) * C * ln((Vcc - CV/2) / (Vcc - CV))
 *     t_low  = R2 * C * ln(2)
 *
 *   R1 = 100k throughout, R2 = 470k / 330k / 220k, C = 10nF:
 *     F1  138.7 Hz -> 254.5 Hz   (1.83x)
 *     F2  189.8 Hz -> 357.9 Hz   (1.89x)
 *     F3  267.2 Hz -> 525.8 Hz   (1.97x)
 *
 * So the swarm hum is not a steady drone with a wobble on it: each tone sweeps
 * an octave, and that sweep is the "wow". Pinning them at the bottom of the
 * range with a small wobble sounds an octave flat, which is exactly what this
 * first got wrong.
 *
 * @see docs/video-sound.md section A.9.1
 */
const BACKGROUND_HZ = [138.7, 189.8, 267.2];
/** Top of each tone's sweep, as a multiple of its resting frequency. */
const BACKGROUND_SWEEP = 1.9;
/**
 * Gain of one background tone while its alien survives. Three of them run at
 * once, so this is the voice that dominates the mix; held well under the level
 * the rest of the board is balanced against to keep the swarm's "wow" from
 * burying the pitch and fire voices, but lifted 33% over that first balance so
 * the "wow" reads clearly.
 */
const BACKGROUND_LEVEL = 0.073;
/**
 * Peak gain of the FIRE chirp, at the instant the latch goes high. Lifted 50%
 * over the level the board was first balanced at so the player's shot stays
 * audible over the swarm.
 */
const FIRE_LEVEL = 0.75;
/**
 * Peak gain of the HIT boom. The hardware's RC envelope is well into its decay
 * before the 40-frame explosion animation ends, so the death of the ship is
 * easy to miss; raised to 5.2x the level the board was first balanced at so it
 * carries over the swarm. This is the loudest thing on the board by a wide
 * margin -- see the headroom note on `master`.
 */
const HIT_LEVEL = 3.64;

export class SoundEngine {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    this.enabled = false;
    this.started = false;
    /** Remembers the last values written, so we only touch changed parameters. */
    this.last = { pitch: -1, vol: -1, fire: -1, hit: -1, bg: [-1, -1, -1], lfo: -1 };
  }

  /**
   * Build the graph. Must be called from a user gesture, because browsers will
   * not let a page make noise before one.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.started) {
      if (this.ctx !== null && this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (Ctor === undefined) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.started = true;

    this.master = ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(ctx.destination);

    // --- PITCH voice -------------------------------------------------------
    this.pitchOsc = ctx.createOscillator();
    this.pitchOsc.type = 'square';
    this.pitchOsc.frequency.value = 440;
    this.pitchGain = ctx.createGain();
    this.pitchGain.gain.value = 0;
    this.pitchOsc.connect(this.pitchGain).connect(this.master);
    this.pitchOsc.start();

    // --- BACKGROUND voice --------------------------------------------------
    // One shared LFO sweeps all three tones, which is what gives the swarm its
    // throb; its rate is what speeds up as a wave drags on.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'triangle';
    this.lfo.frequency.value = 1;
    this.lfo.start();

    this.bgOsc = [];
    this.bgGain = [];
    for (const hz of BACKGROUND_HZ) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      // Centre the oscillator in its sweep, then let the LFO carry it between
      // the resting frequency and the top of the range.
      const centre = hz * (1 + BACKGROUND_SWEEP) / 2;
      const depth = hz * (BACKGROUND_SWEEP - 1) / 2;
      osc.frequency.value = centre;
      // Each tone needs its own depth, because each sweeps a different span.
      const swing = ctx.createGain();
      swing.gain.value = depth;
      this.lfo.connect(swing);
      swing.connect(osc.frequency);

      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.master);
      osc.start();
      this.bgOsc.push(osc);
      this.bgGain.push(gain);
    }

    // --- Noise source, shared by FIRE and HIT ------------------------------
    const frames = Math.ceil(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Sample-and-hold at 7.9 kHz rather than per-sample white noise.
    const hold = Math.max(1, Math.round(ctx.sampleRate / NOISE_RATE));
    let value = 0;
    for (let i = 0; i < frames; i += 1) {
      if (i % hold === 0) value = Math.random() * 2 - 1;
      data[i] = value;
    }
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buffer;
    this.noise.loop = true;

    this.fireFilter = ctx.createBiquadFilter();
    this.fireFilter.type = 'bandpass';
    this.fireFilter.frequency.value = 1400;
    this.fireFilter.Q.value = 2;
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0;
    this.noise.connect(this.fireFilter).connect(this.fireGain).connect(this.master);

    this.hitFilter = ctx.createBiquadFilter();
    this.hitFilter.type = 'bandpass';
    this.hitFilter.frequency.value = 260;
    this.hitFilter.Q.value = 1.2;
    this.hitGain = ctx.createGain();
    this.hitGain.gain.value = 0;
    this.noise.connect(this.hitFilter).connect(this.hitGain).connect(this.master);

    this.noise.start();
    this.enabled = true;
  }

  /** @returns {boolean} the new state */
  toggle() {
    this.enabled = !this.enabled;
    if (this.master !== undefined) {
      this.master.gain.value = this.enabled ? 0.22 : 0;
    }
    return this.enabled;
  }

  /**
   * Read this frame's latches and update the graph.
   * @param {import('../machine/machine.js').Machine} m
   */
  update(m) {
    const ctx = this.ctx;
    if (ctx === null || !this.started) return;
    const now = ctx.currentTime;
    const glide = 0.004;

    // PITCH. $FF means silence -- the divider runs far above hearing.
    const pitch = m.pitch;
    const vol2 = m.soundRegs[7] & 1;
    if (pitch !== this.last.pitch || vol2 !== this.last.vol) {
      this.last.pitch = pitch;
      this.last.vol = vol2;
      if (pitch >= 0xff) {
        this.pitchGain.gain.setTargetAtTime(0, now, glide);
      } else {
        const f1 = SOUND_CLOCK / (256 - pitch);
        const hz = vol2 ? f1 / 16 : f1 / 8;
        if (hz > 20 && hz < 12000) {
          this.pitchOsc.frequency.setTargetAtTime(hz, now, glide);
          this.pitchGain.gain.setTargetAtTime(0.30, now, glide);
        } else {
          this.pitchGain.gain.setTargetAtTime(0, now, glide);
        }
      }
    }

    // BACKGROUND: one oscillator per surviving alien, up to three.
    for (let i = 0; i < 3; i += 1) {
      const on = m.soundRegs[i] & 1;
      if (on === this.last.bg[i]) continue;
      this.last.bg[i] = on;
      this.bgGain[i].gain.setTargetAtTime(on ? BACKGROUND_LEVEL : 0, now, 0.02);
    }

    // The LFO rate comes from a 4-bit DAC; 15 is slowest, 0 fastest.
    const lfoBits = (m.lfo[0] | (m.lfo[1] << 1) | (m.lfo[2] << 2) | (m.lfo[3] << 3)) & 0x0f;
    if (lfoBits !== this.last.lfo) {
      this.last.lfo = lfoBits;
      // 15 is the slowest throb, 0 the most agitated.
      this.lfo.frequency.setTargetAtTime(1.1 + (15 - lfoBits) * 0.30, now, 0.05);
    }

    // FIRE: gated for exactly 8 frames by the ROM, so just follow the latch.
    const fire = m.soundRegs[5] & 1;
    if (fire !== this.last.fire) {
      this.last.fire = fire;
      if (fire) {
        this.fireGain.gain.cancelScheduledValues(now);
        this.fireGain.gain.setValueAtTime(FIRE_LEVEL, now);
        // tau = 0.1 s, and the tone falls as the envelope decays.
        this.fireGain.gain.setTargetAtTime(0, now, 0.1);
        this.fireFilter.frequency.cancelScheduledValues(now);
        this.fireFilter.frequency.setValueAtTime(2200, now);
        this.fireFilter.frequency.setTargetAtTime(500, now, 0.08);
      }
    }

    // HIT: the player's explosion, tau = 0.38 s.
    const hit = m.soundRegs[3] & 1;
    if (hit !== this.last.hit) {
      this.last.hit = hit;
      if (hit) {
        this.hitGain.gain.cancelScheduledValues(now);
        this.hitGain.gain.setValueAtTime(HIT_LEVEL, now);
        this.hitGain.gain.setTargetAtTime(0, now, 0.38);
      }
    }
  }
}
