/**
 * Canonical Galaxian address map, transcribed from the EQU block in
 * reference/galaxian.asm lines 190-627, plus the hardware map at lines 92-152.
 *
 * This is the single source of truth for both the JavaScript port and the Z80
 * differential oracle. Keeping one table means a symbol can never drift between
 * the thing under test and the thing testing it.
 *
 * Naming follows the disassembly exactly, even where the names are awkward
 * ("GALIXIP" is Namco's own spelling), so that any line of the .asm can be
 * grepped against this file.
 */

/** Regions of the address space. @see reference/galaxian.asm:92-152 */
export const REGION = {
  ROM_START: 0x0000,
  ROM_END: 0x27ff,
  /** 1 KB of static RAM, mirrored across $4000-$47FF. */
  RAM_START: 0x4000,
  RAM_SIZE: 0x0400,
  /** 32x32 tilemap, 1 KB, mirrored across $5000-$57FF. */
  CHAR_RAM_START: 0x5000,
  CHAR_RAM_SIZE: 0x0400,
  /** 256 bytes, mirrored across $5800-$5FFF. */
  OBJ_RAM_START: 0x5800,
  OBJ_RAM_SIZE: 0x0100,
};

/** Offsets within OBJRAM. @see reference/galaxian.asm:101-104, 254-276 */
export const OBJ = {
  /** 32 pairs: even byte = column scroll, odd byte = colour attribute. */
  ATTRIBUTES: 0x00,
  /** 8 sprites x 4 bytes {Y, code+flip, colour, X}. */
  SPRITES: 0x40,
  /** Bullet objects, 4 bytes each; the last is the player's missile. */
  BULLETS: 0x60,
  SPRITE_COUNT: 8,
  SPRITE_STRIDE: 4,
};

/** Bits within a sprite's code byte. @see reference/galaxian.asm:264-270 */
export const SPRITE_FLAG = { CODE_MASK: 0x3f, X_FLIP: 0x40, Y_FLIP: 0x80 };

/** Read/write ports. @see reference/galaxian.asm:105-151 */
export const PORT = {
  /** Read: coin, P1 controls, upright/cocktail, test, service. */
  SW0: 0x6000,
  /** Write: $6000 lamp1, $6001 lamp2, $6002 coin lockout, $6003 coin control. */
  DRIVER_BASE: 0x6000,
  /** Write: $6004-$6007, background LFO frequency bits 0-3. */
  LFO_BASE: 0x6004,
  /** Read: start buttons, P2 controls, dip switches 1 and 2. */
  SW1: 0x6800,
  /** Write: $6800-$6807 sound registers. */
  SOUND_BASE: 0x6800,
  /** Read: dip switches 3-6. */
  DIPSW: 0x7000,
  NMI_ENABLE: 0x7001,
  STARS_ENABLE: 0x7004,
  HFLIP: 0x7006,
  VFLIP: 0x7007,
  /** Read kicks the watchdog; write sets the sound FX base pitch. */
  WATCHDOG_PITCH: 0x7800,
};

/** Bit positions in SW0 ($6000) and SW1 ($6800). Switches are active high. */
export const INPUT_BIT = {
  COIN1: 0, COIN2: 1, P1_LEFT: 2, P1_RIGHT: 3, P1_SHOOT: 4,
  COCKTAIL: 5, TEST: 6, SERVICE: 7,
  START1: 0, START2: 1, P2_LEFT: 2, P2_RIGHT: 3, P2_SHOOT: 4,
  DIP_SW1: 6, DIP_SW2: 7,
};

/** Sound register offsets from PORT.SOUND_BASE. @see reference/galaxian.asm:129-137 */
export const SOUND_REG = {
  BACKGROUND_F1: 0, BACKGROUND_F2: 1, BACKGROUND_F3: 2,
  PLAYER_HIT: 3, SHOOT: 5, VOL_F1: 6, VOL_F2: 7,
};

/**
 * Single byte variables in working RAM.
 * @see reference/galaxian.asm:190-627
 */
export const VAR = {
  DIP_SWITCH_1_2_STATE: 0x4000,
  COIN_COUNT: 0x4001,
  NUM_CREDITS: 0x4002,
  COIN_CONTROL: 0x4003,
  UNPROCESSED_COINS: 0x4004,
  SCRIPT_NUMBER: 0x4005,
  IS_GAME_IN_PLAY: 0x4006,
  IS_GAME_OVER: 0x4007,
  TEMP_COUNTER_1: 0x4008,
  TEMP_COUNTER_2: 0x4009,
  SCRIPT_STAGE: 0x400a,
  TEMP_CHAR_RAM_PTR: 0x400b,
  CURRENT_PLAYER: 0x400d,
  IS_TWO_PLAYER_GAME: 0x400e,
  IS_COCKTAIL: 0x400f,
  PORT_STATE_6000: 0x4010,
  PORT_STATE_6800: 0x4011,
  PORT_STATE_7000: 0x4012,
  PREV_PORT_STATE_6000: 0x4013,
  PREV_PORT_STATE_6800: 0x4014,
  PREV_PREV_PORT_STATE_6000: 0x4015,
  PREV_PREV_PREV_STATE_6000: 0x4016,
  DISPLAY_IS_COCKTAIL_P2: 0x4018,
  PUSH_START_BUTTON_COUNTER: 0x4019,
  DIAGNOSTIC_MESSAGE_TYPE: 0x401a,
  RAND_NUMBER: 0x401e,
  DIP_SWITCH_5_STATE: 0x401f,

  CIRC_CMD_QUEUE_PTR_LO: 0x40a0,
  CIRC_CMD_QUEUE_PROC_LO: 0x40a1,
  CAN_BLINK_1UP_2UP: 0x40ab,
  BONUS_GALIXIP_FOR: 0x40ac,
  PLAYER_ONE_AWARDED_EXTRA_LIFE: 0x40ad,
  PLAYER_TWO_AWARDED_EXTRA_LIFE: 0x40ae,
  IS_COLUMN_SCROLLING: 0x40b0,
  COLUMN_SCROLL_ATTR_BACKBUF_PTR: 0x40b1,
  COLUMN_SCROLL_NEXT_CHAR_PTR: 0x40b3,
  COLUMN_SCROLL_CHAR_RAM_PTR: 0x40b5,

  HAS_PLAYER_SPAWNED: 0x4200,
  IS_PLAYER_DYING: 0x4201,
  PLAYER_Y: 0x4202,
  IS_PLAYER_HIT: 0x4204,
  PLAYER_EXPLOSION_COUNTER: 0x4205,
  PLAYER_EXPLOSION_ANIM_FRAME: 0x4206,
  HAS_PLAYER_BULLET_BEEN_FIRED: 0x4208,
  PLAYER_BULLET_X: 0x4209,
  PLAYER_BULLET_Y: 0x420a,
  IS_PLAYER_BULLET_DONE: 0x420b,

  SWARM_DIRECTION: 0x420d,
  SWARM_SCROLL_VALUE: 0x420e,
  SWARM_SCROLL_MAX_EXTENTS: 0x4210,
  INFLIGHT_ALIEN_SHOOT_RANGE_MUL: 0x4213,
  INFLIGHT_ALIEN_SHOOT_EXACT_X: 0x4214,
  ALIENS_ATTACK_FROM_RIGHT_FLANK: 0x4215,

  DIFFICULTY_COUNTER_1: 0x4218,
  DIFFICULTY_COUNTER_2: 0x4219,
  DIFFICULTY_EXTRA_VALUE: 0x421a,
  DIFFICULTY_BASE_VALUE: 0x421b,
  PLAYER_LEVEL: 0x421c,
  PLAYER_LIVES: 0x421d,
  FLAGSHIP_SURVIVOR_COUNT: 0x421e,
  LFO_FREQ_BITS: 0x421f,

  HAVE_NO_ALIENS_IN_SWARM: 0x4220,
  HAVE_NO_BLUE_OR_PURPLE_ALIENS: 0x4221,
  LEVEL_COMPLETE: 0x4222,
  NEXT_LEVEL_DELAY_COUNTER: 0x4223,
  HAVE_AGGRESSIVE_ALIENS: 0x4224,
  HAVE_NO_INFLIGHT_OR_DYING_ALIENS: 0x4225,
  HAVE_NO_INFLIGHT_ALIENS: 0x4226,
  CAN_ALIEN_ATTACK: 0x4228,
  CAN_FLAGSHIP_OR_RED_ALIENS_ATTACK: 0x4229,
  FLAGSHIP_ESCORT_COUNT: 0x422a,
  IS_FLAGSHIP_HIT: 0x422b,
  ALIENS_IN_SHOCK_COUNTER: 0x422c,
  FLAGSHIP_SCORE_FACTOR: 0x422d,
  ENABLE_FLAGSHIP_ATTACK_SECONDARY_COUNTER: 0x422e,
  FLAGSHIP_ATTACK_SECONDARY_COUNTER: 0x422f,
  DISABLE_SWARM_ANIMATION: 0x4238,
  ATTRACT_MODE_FAKE_CONTROLLER: 0x423f,
  ATTRACT_MODE_SCROLL_ID: 0x4241,
  FLAGSHIP_ATTACK_MASTER_COUNTER_1: 0x4245,
  FLAGSHIP_ATTACK_MASTER_COUNTER_2: 0x4246,
  ALIEN_ATTACK_MASTER_COUNTER: 0x424a,
  TIMING_VARIABLE: 0x425f,

  SOUND_VOL: 0x41c0,
  PITCH_SOUND_FX_BASE_FREQ: 0x41c1,
  ENABLE_ALIEN_ATTACK_SOUND: 0x41c2,
  PLAY_EXTRA_LIFE_SOUND: 0x41c7,
  EXTRA_LIFE_SOUND_COUNTER: 0x41c8,
  PLAY_PLAYER_CREDIT_SOUND: 0x41c9,
  PLAYER_CREDIT_SOUND_COUNTER: 0x41ca,
  PLAY_PLAYER_SHOOT_SOUND: 0x41cc,
  IS_COMPLEX_SOUND_PLAYING: 0x41cd,
  PLAYER_SHOOT_SOUND_COUNTER: 0x41ce,
  RESET_SWARM_SOUND_TEMPO: 0x41d0,
  PLAY_GAME_START_MELODY: 0x41d1,
  COMPLEX_SOUND_POINTER: 0x41d3,
  DELAY_BEFORE_NEXT_SOUND: 0x41d6,
  ALIEN_DEATH_SOUND: 0x41df,
};

/** Arrays and structured blocks in working RAM. */
export const BLOCK = {
  /** Colour/scroll + sprite + bullet back buffer, blitted to OBJRAM each NMI. */
  OBJRAM_BACK_BUF: { addr: 0x4020, size: 0x80 },
  OBJRAM_BACK_BUF_SPRITES: { addr: 0x4060, size: 0x20 },
  OBJRAM_BACK_BUF_BULLETS: { addr: 0x4080, size: 0x20 },
  OBJRAM_BUF_PLAYER_BULLET_Y: { addr: 0x409d, size: 1 },
  OBJRAM_BUF_PLAYER_BULLET_X: { addr: 0x409f, size: 1 },

  /** Three packed BCD bytes each, little endian. @see .asm:279-286 */
  PLAYER_ONE_SCORE: { addr: 0x40a2, size: 3 },
  PLAYER_TWO_SCORE: { addr: 0x40a5, size: 3 },
  HI_SCORE: { addr: 0x40a8, size: 3 },

  /** 32 entries of {command, parameter}. @see .asm:299-324 */
  CIRC_CMD_QUEUE: { addr: 0x40c0, size: 0x40 },

  /** 128 cells; index = row*16 + col, rows 2-7, cols 3-12. @see .asm:327-356 */
  ALIEN_SWARM_FLAGS: { addr: 0x4100, size: 0x80 },

  PLAYER_ONE_PACKED_SWARM_DEF: { addr: 0x4180, size: 0x10 },
  PLAYER_ONE_STATE: { addr: 0x4190, size: 8 },
  PLAYER_TWO_PACKED_SWARM_DEF: { addr: 0x41a0, size: 0x10 },
  PLAYER_TWO_STATE: { addr: 0x41b0, size: 8 },
  CURRENT_PLAYER_STATE: { addr: 0x4218, size: 8 },

  /** Six flags; the first two entries are never used. @see .asm:411-421 */
  HAVE_ALIENS_IN_ROW_FLAGS: { addr: 0x41e8, size: 8 },
  /** Ordered rightmost to leftmost; only $41F3-$41FC are used. @see .asm:424-464 */
  ALIEN_IN_COLUMN_FLAGS: { addr: 0x41f0, size: 0x10 },

  /** Master counter then 15 secondaries. @see .asm:536-543 */
  ALIEN_ATTACK_COUNTERS: { addr: 0x424a, size: 0x10 },
  /** 14 records of 5 bytes. @see .asm:549-566 */
  ENEMY_BULLETS: { addr: 0x4260, size: 70 },
  /** 8 records of 32 bytes; slot 0 is the shared explosion scratch. @see .asm:570-626 */
  INFLIGHT_ALIENS: { addr: 0x42b0, size: 0x100 },
};

/** @see reference/galaxian.asm:555-562 */
export const ENEMY_BULLET = {
  SIZE: 5, COUNT: 14,
  IS_ACTIVE: 0, X: 1, Y_LO: 2, Y_HI: 3, Y_DELTA: 4,
};

/**
 * Field offsets within an INFLIGHT_ALIEN record.
 * @see reference/galaxian.asm:588-622
 */
export const INFLIGHT_ALIEN = {
  SIZE: 32, COUNT: 8,
  IS_ACTIVE: 0x00,
  IS_DYING: 0x01,
  STAGE_OF_LIFE: 0x02,
  X: 0x03,
  Y: 0x04,
  ANIMATION_FRAME: 0x05,
  ARC_CLOCKWISE: 0x06,
  INDEX_IN_SWARM: 0x07,
  PIVOT_Y_VALUE: 0x09,
  ANIM_FRAME_START_CODE: 0x0f,
  TEMP_COUNTER_1: 0x10,
  TEMP_COUNTER_2: 0x11,
  DEATH_ANIM_CODE: 0x12,
  ARC_TABLE_LSB: 0x13,
  COLOUR: 0x16,
  SORTIE_COUNT: 0x17,
  SPEED: 0x18,
  PIVOT_Y_VALUE_ADD: 0x19,
};

/**
 * Slot assignment within INFLIGHT_ALIENS, so at most 7 aliens are ever in
 * flight at once. @see reference/galaxian.asm:576-583
 */
export const INFLIGHT_SLOT = {
  EXPLOSION_SCRATCH: 0,
  FLAGSHIP: 1,
  ESCORT_A: 2,
  ESCORT_B: 3,
  FIRST_ATTACKER: 4,
  LAST_ATTACKER: 7,
};

/** Reverse lookup from address to symbol, for readable diff failures. */
export const SYMBOL_BY_ADDRESS = (() => {
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const [name, addr] of Object.entries(VAR)) map.set(addr, name);
  for (const [name, { addr, size }] of Object.entries(BLOCK)) {
    for (let i = 0; i < size; i += 1) {
      if (!map.has(addr + i)) map.set(addr + i, size === 1 ? name : `${name}+${i}`);
    }
  }
  return map;
})();

/**
 * Describe an address the way the disassembly would, e.g. "$4202 PLAYER_Y".
 * Used by the oracle diff so a failure names a variable, not a number.
 * @param {number} addr
 * @returns {string}
 */
export function describeAddress(addr) {
  const hex = `$${addr.toString(16).toUpperCase().padStart(4, '0')}`;
  const name = SYMBOL_BY_ADDRESS.get(addr);
  return name === undefined ? hex : `${hex} ${name}`;
}
