/**
 * The sound subsystem.
 *
 * Galaxian has no sound CPU. The board is discrete analogue circuitry driven by
 * ten write-only latch bits plus an eight bit pitch latch, and this module is
 * the code that drives them -- the same code the ROM runs, producing the same
 * register writes. Turning those writes into audible sound is the audio layer's
 * job; nothing here knows about WebAudio.
 *
 * Four voices:
 *   PITCH ($7800 + the two VOL bits)   melodies, the coin and extra-life tones
 *   BACKGROUND ($6800-$6802, $6004-7)  the swarm hum, one oscillator per alien
 *   HIT ($6803)                        the player's death explosion
 *   FIRE ($6805)                       the player's shot
 *
 * HANDLE_SOUND clears the pitch to $FF (silence) at the top of every frame and
 * lets each handler in turn overwrite it, so the last writer wins. That
 * ordering is the priority scheme: coin beats extra life beats melody beats the
 * diving-alien swoop.
 *
 * @see reference/galaxian.asm:5667-6026
 * @see docs/video-sound.md section A.9
 */

import { VAR, PORT } from '../machine/addresses.js';
import {
  PITCH_TABLE, DURATION_TABLE,
  MELODY_GAME_START, MELODY_ALIEN_DEATH, MELODY_FLAGSHIP_DEATH,
} from './tables.js';

/** Silence: 96 kHz is far above hearing. @see reference/galaxian.asm:5670 */
const SILENT_PITCH = 0xff;

/**
 * The melodies still live at their ROM addresses so that
 * COMPLEX_SOUND_POINTER holds exactly the value the original would, which keeps
 * the port comparable to the Z80 oracle byte for byte.
 * @type {ReadonlyArray<{base: number, data: readonly number[]}>}
 */
const MELODIES = [
  { base: 0x1e68, data: MELODY_GAME_START },
  { base: 0x1ebd, data: MELODY_ALIEN_DEATH },
  { base: 0x1edf, data: MELODY_FLAGSHIP_DEATH },
];

/**
 * Read a melody byte at a ROM address.
 * @param {number} addr
 * @returns {number} the byte, or the end marker if the address is not a melody
 */
function readMelody(addr) {
  for (const { base, data } of MELODIES) {
    if (addr >= base && addr < base + data.length) return data[addr - base];
  }
  return 0xe0; // end marker, so a stray pointer stops rather than runs away
}

/**
 * HANDLE_SOUND ($16F5). Called once per frame from the NMI, before the script.
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSound(m) {
  m.poke(VAR.SOUND_VOL, 0);
  m.poke(VAR.PITCH_SOUND_FX_BASE_FREQ, SILENT_PITCH);

  handleGameStartMelody(m);
  handleAlienAttackSound(m);
  handleAlienDeathSound(m);
  handleComplexSounds(m);
  handleExtraLifeSound(m);
  handleCoinInsertSound(m);
  handlePlayerShootingSound(m);

  const vol = m.peek(VAR.SOUND_VOL);
  m.write(PORT.SOUND_BASE + 6, vol);
  // `rrca` -- an 8-bit rotate, so VOL2 comes from bit 1.
  m.write(PORT.SOUND_BASE + 7, ((vol >> 1) | (vol << 7)) & 0xff);
  m.write(PORT.WATCHDOG_PITCH, m.peek(VAR.PITCH_SOUND_FX_BASE_FREQ));
}

/**
 * HANDLE_PLAYER_SHOOTING_SOUND ($1723). Eight frames of the FIRE gate.
 * @see reference/galaxian.asm:5689-5706
 * @param {import('../machine/machine.js').Machine} m
 */
export function handlePlayerShootingSound(m) {
  if (m.peek(VAR.PLAY_PLAYER_SHOOT_SOUND) === 1) {
    m.poke(VAR.PLAY_PLAYER_SHOOT_SOUND, 0);
    m.poke(VAR.PLAYER_SHOOT_SOUND_COUNTER, 8);
    return;
  }
  const counter = m.peek(VAR.PLAYER_SHOOT_SOUND_COUNTER);
  if (counter === 0) { m.write(PORT.SOUND_BASE + 5, 0); return; }
  m.poke(VAR.PLAYER_SHOOT_SOUND_COUNTER, (counter - 1) & 0xff);
  // Silent during attract mode, which is why the demo ship's shots make no noise.
  m.write(PORT.SOUND_BASE + 5, m.peek(VAR.IS_GAME_OVER) ^ 1);
}

/** HANDLE_GAME_START_MELODY ($1747). @see reference/galaxian.asm:5713-5723 */
export function handleGameStartMelody(m) {
  if (m.peek(VAR.PLAY_GAME_START_MELODY) !== 1) return;
  m.poke(VAR.PLAY_GAME_START_MELODY, 0);
  m.poke(0x41d2, 1);                 // melody slot A
  m.poke(VAR.DELAY_BEFORE_NEXT_SOUND, 1);
  m.poke16(VAR.COMPLEX_SOUND_POINTER, 0x1e68);
}

/**
 * HANDLE_COMPLEX_SOUNDS ($175D). A tiny sequencer shared by three slots.
 *
 * Each melody byte packs a duration index in the top three bits and a note
 * index in the low five; $E0 ends the tune and frees the slot.
 *
 * @see reference/galaxian.asm:5731-5776
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleComplexSounds(m) {
  for (const flagAddr of [0x41d2, 0x41cf, VAR.IS_COMPLEX_SOUND_PLAYING]) {
    playComplexSlot(m, flagAddr);
  }
}

/** @param {import('../machine/machine.js').Machine} m @param {number} flagAddr */
function playComplexSlot(m, flagAddr) {
  if (m.peek(flagAddr) === 0) return;

  m.poke(VAR.SOUND_VOL, 2); // VOL2, which drops the fundamental to f1/16
  m.poke(VAR.PITCH_SOUND_FX_BASE_FREQ, m.peek(0x41d5));

  const delay = (m.peek(VAR.DELAY_BEFORE_NEXT_SOUND) - 1) & 0xff;
  if (delay !== 0) { m.poke(VAR.DELAY_BEFORE_NEXT_SOUND, delay); return; }

  const pointer = m.peek16(VAR.COMPLEX_SOUND_POINTER);
  const byte = readMelody(pointer);
  if (byte === 0xe0) { m.poke(flagAddr, 0); return; }

  m.poke16(VAR.COMPLEX_SOUND_POINTER, (pointer + 1) & 0xffff);
  m.poke(0x41d5, PITCH_TABLE[byte & 0x1f]);
  // `rlca` three times on the masked top bits is the same as >> 5 here.
  m.poke(VAR.DELAY_BEFORE_NEXT_SOUND, DURATION_TABLE[(byte & 0xe0) >> 5]);
}

/**
 * HANDLE_ALIEN_ATTACK_SOUND ($17D0). The descending swoop a diving alien makes.
 *
 * A counter falls from $A0 to 0 at one step every other frame -- about five
 * seconds -- and the pitch follows it down. Below $60 a phase counter starts
 * advancing and the tone warbles between three values instead.
 *
 * @see reference/galaxian.asm:5819-5858
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleAlienAttackSound(m) {
  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) return;

  if (m.peek(VAR.ENABLE_ALIEN_ATTACK_SOUND) === 1) {
    m.poke(VAR.ENABLE_ALIEN_ATTACK_SOUND, 0);
    m.poke(0x41c3, 0x02);
    m.poke(0x41c4, 0xa0);
    return;
  }
  if ((m.peek(VAR.HAVE_NO_INFLIGHT_ALIENS) & 1) !== 0) return;

  let level = m.peek(0x41c4);
  // The `jr c,$1801` at $17EF skips only the decay on odd frames -- the pitch
  // below is recomputed every frame regardless, so the tone is continuous and
  // it is the sweep that runs at half rate.
  if ((m.peek(VAR.TIMING_VARIABLE) & 1) === 0) {
    if (level < 0x60) m.poke(0x41c3, (m.peek(0x41c3) + 1) & 0xff);
    if (level !== 0) { level = (level - 1) & 0xff; m.poke(0x41c4, level); }
  }

  const phase = m.peek(0x41c3) & 3;
  let pitch;
  if (phase === 0) {
    pitch = 0x60;
  } else if (phase === 2) {
    pitch = level;
  } else {
    // `add a,$60` then `rra`. The rotate brings in the carry the *addition*
    // produced, not the one from the earlier `rrca`, so bit 7 is set only when
    // the sum overflowed. Forcing it on makes the warble an octave out.
    const sum = level + 0x60;
    pitch = (((sum & 0xff) >> 1) | (sum > 0xff ? 0x80 : 0)) & 0xff;
  }
  m.poke(VAR.PITCH_SOUND_FX_BASE_FREQ, pitch);
}

/**
 * HANDLE_ALIEN_DEATH_SOUND ($1819). Picks which death jingle to start.
 *
 * The game writes $07 or $17 into ALIEN_DEATH_SOUND and a separate handler
 * decrements it, so the value reaches $06 or $16 on the following frame and
 * triggers here. Flagships get their own, longer fanfare and take priority.
 *
 * @see reference/galaxian.asm:5867-5896
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleAlienDeathSound(m) {
  if ((m.peek(VAR.IS_GAME_IN_PLAY) & 1) === 0) return;
  const which = m.peek(VAR.ALIEN_DEATH_SOUND);

  if (which === 0x06) {
    if ((m.peek(VAR.IS_COMPLEX_SOUND_PLAYING) & 1) !== 0) return;
    m.poke(0x41cf, 1);
    m.poke(VAR.DELAY_BEFORE_NEXT_SOUND, 1);
    m.poke16(VAR.COMPLEX_SOUND_POINTER, 0x1ebd);
    return;
  }
  if (which !== 0x16) return;
  m.poke(0x41cf, 0);
  m.poke(VAR.IS_COMPLEX_SOUND_PLAYING, 1);
  m.poke(VAR.DELAY_BEFORE_NEXT_SOUND, 1);
  m.poke16(VAR.COMPLEX_SOUND_POINTER, 0x1edf);
}

/**
 * HANDLE_EXTRA_LIFE_SOUND ($184F). A 1500 Hz beep, four frames on and four off,
 * for 128 frames. @see reference/galaxian.asm:5904-5925
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleExtraLifeSound(m) {
  if ((m.peek(VAR.PLAY_EXTRA_LIFE_SOUND) & 1) !== 0) {
    m.poke(VAR.PLAY_EXTRA_LIFE_SOUND, 0);
    m.poke(VAR.EXTRA_LIFE_SOUND_COUNTER, 0x80);
    return;
  }
  const counter = m.peek(VAR.EXTRA_LIFE_SOUND_COUNTER);
  if (counter === 0) return;
  const next = (counter - 1) & 0xff;
  m.poke(VAR.EXTRA_LIFE_SOUND_COUNTER, next);
  m.poke(VAR.PITCH_SOUND_FX_BASE_FREQ, (next & 0x04) !== 0 ? SILENT_PITCH : 0x80);
  m.poke(VAR.SOUND_VOL, 1);
}

/**
 * HANDLE_COIN_INSERT_SOUND ($1876). A rising sweep over 32 frames.
 * @see reference/galaxian.asm:5930-5953
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleCoinInsertSound(m) {
  if (m.peek(VAR.PLAY_PLAYER_CREDIT_SOUND) === 1) {
    m.poke(VAR.PLAY_PLAYER_CREDIT_SOUND, 0);
    m.poke(VAR.PLAYER_CREDIT_SOUND_COUNTER, 0x20);
    m.poke(0x41cb, 0);
    return;
  }
  const counter = m.peek(VAR.PLAYER_CREDIT_SOUND_COUNTER);
  if (counter === 0) return;
  m.poke(VAR.PLAYER_CREDIT_SOUND_COUNTER, (counter - 1) & 0xff);
  const pitch = (m.peek(0x41cb) + 4) & 0xff;
  m.poke(0x41cb, pitch);
  m.poke(VAR.PITCH_SOUND_FX_BASE_FREQ, pitch);
  m.poke(VAR.SOUND_VOL, 0);
}

/**
 * HANDLE_SWARM_SOUND ($1898). The background throb.
 *
 * LFO_FREQ_BITS starts at 15 (slowest) each wave and falls by one every 256
 * frames, so the hum gets steadily more agitated the longer a wave takes --
 * about a minute to reach its fastest. The four bits drive a DAC feeding the
 * oscillator that sweeps the three background tones.
 *
 * @see reference/galaxian.asm:5962-5985
 * @param {import('../machine/machine.js').Machine} m
 */
export function handleSwarmSound(m) {
  if (m.peek(VAR.RESET_SWARM_SOUND_TEMPO) !== 0) {
    m.poke(VAR.RESET_SWARM_SOUND_TEMPO, 0);
    m.poke(VAR.LFO_FREQ_BITS, 0x0f);
  } else {
    // Only once every 256 frames, when the free-running counter wraps.
    if (((m.peek(VAR.TIMING_VARIABLE) + 1) & 0xff) !== 0) return;
    const bits = m.peek(VAR.LFO_FREQ_BITS);
    if (bits === 0) return;
    m.poke(VAR.LFO_FREQ_BITS, (bits - 1) & 0xff);
  }
  let bits = m.peek(VAR.LFO_FREQ_BITS);
  for (let i = 0; i < 4; i += 1) {
    m.write(PORT.LFO_BASE + i, bits & 1);
    bits = ((bits >> 1) | (bits << 7)) & 0xff; // rrca
  }
}

/**
 * RESET_SOUND ($1CB5). Silences the board.
 *
 * Called on game over, so the swarm hum does not carry on into the attract
 * screen. Note it sets the LFO bits to 1 rather than 0, and parks the pitch
 * latch at $FF, which is silence.
 *
 * @see reference/galaxian.asm:6730-6744
 * @param {import('../machine/machine.js').Machine} m
 */
export function resetSound(m) {
  for (let i = 0; i < 4; i += 1) m.write(PORT.LFO_BASE + i, 1);
  for (let i = 0; i < 8; i += 1) m.write(PORT.SOUND_BASE + i, 0);
  for (let i = 0; i < 5; i += 1) m.write(PORT.NMI_ENABLE + i, 0);
  m.write(PORT.WATCHDOG_PITCH, 0xff);
}
