# Galaxian (1979) — a JavaScript port proven against the original ROM

A, bit-compatible,  algorithm-faithful browser recreation of Namco's **Galaxian**,
written in plain ES modules with no build step and no dependencies. It is not an emulator: no Z80
executes when you play it. Every routine of the 1979 program has been reimplemented
in JavaScript.


The ga,e  keeps the original memory map (ram, charRam,
objRam as Uint8Arrays at the 1979 addresses). No Alien class, no Player object.
  
That's precisely what makes the comparison a byte diff rather than a hand-written state
mapping — and a hand-written mapping is exactly where bugs would hide.

This galaxian uses a cycle-accurate Z80 + Galaxian board running the original 1979 machine code,
and the JS port, steps them together frame by frame with identical inputs, and diffs $4000–$43BF
— every game variable. 1200 frames of scripted play, plus a ~1950-frame attract sequence compared on RAM,
char RAM and OBJRAM.

 An emulator needs the ROM you can't legally distribute. We use the annotated assembly by Steve Tunstall. 

What makes that claim checkable is the thing this repository is really about:

> A Z80 emulator runs the **original 1979 machine code** next to the JavaScript port,
> frame by frame, with identical inputs, and asserts that **every byte of game state
> matches**.

Not "looks right". Not "plays about the same". Byte-identical RAM, character RAM and
sprite RAM, for thousands of frames, through attract mode and real gameplay.

I played both side by side for many thousands of waves, and the frames are bit-correct all teh way, 
as well as timer-correct. 

```
$ npm test
ℹ tests 272
ℹ pass 272
ℹ fail 0
```

---

## Quick start

```sh
npm run serve          # static server on 127.0.0.1:8000, loopback only
open http://localhost:8000
```

| Key | Action |
|-----|--------|
| ← → | move |
| Space | fire |
| 5 / 6 | insert coin (player 1 / 2 slot) |
| 1 / 2 | start 1 player / 2 player |
| A | toggle the self-playing AI |
| M | mute / unmute |
| G | joystick bindings |
| + / − | zoom the canvas by whole pixels |

A USB joystick or gamepad drives left, right and fire; coin and start stay on
the keyboard. Press `G` to bind the controls — see [§7](#7-input-keyboard-and-joystick).

```sh
npm test               # unit + oracle suites (Node >= 20, no deps)
npm run test:oracle    # just the differential tests against the real ROM
npm run rom            # rebuild reference/galaxian.rom from the disassembly
node tools/shoot.mjs         # screenshot the ORIGINAL ROM through our renderer
node tools/shoot-port.mjs    # screenshot the PORT through the same renderer
```

---

## Table of contents

1. [Where the ROM comes from](#1-where-the-rom-comes-from)
2. [The Z80 oracle](#2-the-z80-oracle)
3. [Lock-step differential testing](#3-lock-step-differential-testing)
4. [Why the port keeps the original memory map](#4-why-the-port-keeps-the-original-memory-map)
5. [Z80 assembly vs. JavaScript, side by side](#5-z80-assembly-vs-javascript-side-by-side)
6. [Video: the screen is sideways](#6-video-the-screen-is-sideways)
7. [Input: keyboard and joystick](#7-input-keyboard-and-joystick)
8. [Sound: four voices of analogue circuitry](#8-sound-four-voices-of-analogue-circuitry)
9. [Data and graphics are generated, never transcribed](#9-data-and-graphics-are-generated-never-transcribed)
10. [What the lock-step actually caught](#10-what-the-lock-step-actually-caught)
11. [Repository layout](#11-repository-layout)
12. [Status and known divergences](#12-status-and-known-divergences)

---

## 1. Where the ROM comes from

There is no ROM dump in this repository. `reference/galaxian.rom` is **reconstructed**
from Scott Tunstall's annotated disassembly, `reference/galaxian.asm`, which is not
just mnemonics — every line carries the opcode bytes the original assembler emitted:

```
0079: 21 20 40      ld   hl,$4020            ; pointer to OBJRAM_BACK_BUF buffer held in RAM
007C: 11 00 58      ld   de,$5800            ; start of screen attribute RAM
007F: 01 80 00      ld   bc,$0080            ; number of bytes to copy
0082: ED B0         ldir                     ; update screen & sprites in one go
```

`tools/build-rom.mjs` parses those address-prefixed hex runs back into a 10 KB image:

```
$ node tools/build-rom.mjs --verify
Galaxian ROM reconstruction
  image size      10240 bytes ($0000-$27FF)
  code ends at    $25B3
  from listing    9650 / 9652 bytes (99.98%)
  inferred        2 padding bytes
  conflicts       0
  gaps            0
  raw sum         $9f
  fixup at        $27FF = $60
  final sum       0 (ROM self test needs 0)
```

Three details make this trustworthy rather than hopeful:

* **Conflicts must be zero.** The listing prints some regions more than once (data
  tables reappear as commentary). Every byte is cross-checked against every other
  mention of the same address; a single disagreement fails the build.
* **Gaps must be zero.** Exactly two bytes below `CODE_END` are missing from the
  listing, and neither is a guess. `$15F3` is an unreferenced alignment byte between
  two tables. `$1E67` is the last byte of `INFLIGHT_ALIEN_ARC_TABLE`, in a region of
  strictly alternating `01 00` pairs, and the table must end there because the GAME
  START melody begins at `$1E68`. Both are documented in the tool.
* **The ROM's own self-test passes.** `ROM_CHECKSUM` at `$28`-pages sums the image
  and requires zero. Real Galaxian ROMs carry a correction byte in their padding;
  ours goes in the very last byte, far past any code. The reconstructed image
  therefore boots through the power-on diagnostics the same way the arcade board does.

`test/unit/build-rom.test.mjs` re-runs all of this on every test run.

---

## 2. The Z80 oracle

`test/z80/` is a small, exact arcade board — three files, about 1900 lines, and
the entire reason the fidelity claim in this README is checkable rather than
aspirational. It is only ever loaded by tests and tools; nothing in `src/`
imports it, and no Z80 executes when you play the game.

| File | Lines | What it is |
|------|------:|-----------|
| `z80.mjs` | 1160 | Cycle-counted Z80 CPU core |
| `machine.mjs` | 411 | The Galaxian board: memory map, mirrors, I/O, vblank NMI |
| `symbols.mjs` | 339 | Every RAM variable name from the disassembly's EQU block |

### 2.1 `z80.mjs` — the CPU core

A complete Z80: every documented opcode plus the `CB`, `ED`, `DD`, `FD`, `DDCB`
and `FDCB` prefixes, the shadow register set, `IX`/`IY` and their undocumented
halves, all three interrupt modes, and `NMI`.

**State.** Registers are kept as individual bytes with 16-bit pairs exposed as
accessors (`get hl()` / `set hl(v)`), because the ROM reads and writes the halves
independently as often as the pairs. Reset matches a real part: `AF` and the
index registers come up `$FF`, `SP` is `$FFFF`, `PC` is 0. `R` is stored as a
7-bit counter plus a separate `r7`, since bit 7 is only ever changed by `LD R,A`
and is *preserved* across the automatic increment — a detail the test suite pins
down explicitly.

**Flags are the hard part, and they are exact.** Three lookup tables are built
once at module load:

```js
for (let i = 0; i < 256; i += 1) {
  let bits = 0;
  for (let b = 0; b < 8; b += 1) bits += (i >> b) & 1;
  PARITY[i] = bits % 2 === 0 ? PV : 0;
  SZXY[i]   = (i & (SF | XF | YF)) | (i === 0 ? ZF : 0);
  SZXYP[i]  = SZXY[i] | PARITY[i];
}
```

`XF` and `YF` are the **undocumented** bit-3 and bit-5 copies of the result. They
are not optional here: the Galaxian ROM threads booleans through `rrca` + `jr c`
chains and leaves X/Y lying around after `bit`, so an "approximately right" flag
model cannot serve as a differential oracle — it would diverge and you would not
know whether the port or the emulator was wrong. `MEMPTR`/`WZ` is modelled too,
because it is what supplies X/Y for `bit n,(hl)`.

One deliberate simplification, documented in the file: the NMOS "Q" register that
perturbs X/Y after `SCF`/`CCF` is not modelled — those take X/Y from `A`, which is
the behaviour in *The Undocumented Z80 Documented* and what every other emulator
implements. No Galaxian code path can observe the difference, because the ROM only
ever uses `scf`/`ccf` to feed a carry (as in `CALCULATE_TANGENT`).

**Cycle counting.** A 256-entry `BASE_CYCLES` table holds the T-states for every
unprefixed opcode. Conditional instructions store the *not-taken* figure and the
branch site adds the difference; the four prefix bytes store 0 and prefixed
instructions account for themselves. This matters because the board's frame engine
schedules the vblank NMI **by cycle position inside the frame**, so a wrong T-state
count moves the interrupt and silently changes behaviour.

**Interrupts.** `step()` handles NMI first: clear the pending flag, un-halt, bump
`R`, copy `IFF1` into `IFF2`, clear `IFF1`, push `PC`, vector to `$0066`, charge 11
T-states. Maskable interrupts follow with all three modes (`IM 0` executes the bus
byte — in practice always an `RST`; `IM 1` vectors to `$0038`; `IM 2` reads the
vector through `I`). Galaxian never asserts `INT` — the board wires vblank to NMI
only — but a core without it is not a Z80, and `RETN` correctness is free once
`IFF2` is right. The `EI` shadow is modelled with an `eiPending` flag so an
interrupt cannot be taken in the instruction slot immediately after `EI`.

**The bus is an injected interface**, not hard-wired memory:

```js
this.cpu = new Z80({
  read:    (addr) => this.read(addr),
  write:   (addr, value) => this.write(addr, value),
  readIo:  () => 0xff,     // the board has no Z80 I/O space at all;
  writeIo: () => {},       // everything is memory mapped
});
```

`test/unit/z80.test.mjs` (693 lines) exercises the core standalone: `DAA` against
the Zilog manual for all 2048 `(A, N/H/C)` combinations, `LDIR`'s interruptibility
and its 21/16 T-state split, `BIT n,(HL)` taking X/Y from `WZ` rather than from the
byte in memory, `LD A,I` copying `IFF2` into the parity flag, `R` incrementing once
per M1 fetch with bit 7 preserved, `DDCB` writing its result back to both memory and
the named register, and T-state counts against the Zilog tables.

### 2.2 `machine.mjs` — the board

Everything outside the CPU, transcribed from the MAME-derived table in the
disassembly header (`.asm:92-152`).

**The memory decode is the whole game.** Reads and writes are a ladder of address
comparisons, and three things in it are easy to get wrong — all three of which the
ROM's own power-on diagnostics will catch:

```js
read(addr) {
  const a = addr & 0xffff;
  if (a < 0x4000) return a < this.rom.length ? this.rom[a] : 0xff;
  if (a < 0x4800) return this.ram[a & 0x3ff];      // 1 KB, mirrored
  if (a < 0x5000) return 0xff;                     // no chip decoded here
  if (a < 0x5800) return this.charRam[a & 0x3ff];  // 1 KB, mirrored
  if (a < 0x6000) return this.objRam[a & 0xff];    // 256 bytes, mirrored 8x
  if (a < 0x6800) return this.in0 & 0xff;          // SW0
  if (a < 0x7000) return this.in1 & 0xff;          // SW1 + DIP 1/2
  if (a < 0x7800) return this.in2 & 0x0f;          // DIP 3-6
  if (a < 0x8000) { this.watchdogKicks += 1; return 0xff; }
  return 0xff;
}
```

* **The RAM chips are small, so they mirror.** `& 0x3ff` for working and character
  RAM; `& 0xff` for OBJRAM, which is a mere 256 bytes repeated eight times across
  `$5800-$5FFF`.
* **Unpopulated regions float high.** `$4800-$4FFF` decodes to no chip and reads
  `$FF`, as does the ROM window above the 10 KB image.
* **Write latches are selected by A0-A2 only.** A3-A10 are ignored, which is why
  the hardware map shows `$6000-$6007` sitting inside a 2 KB window — and each latch
  stores a single bit (`v & 1`), because that is all the hardware keeps.

Reading `$7800` kicks the watchdog, so the board also provides `peek()` — a
side-effect-free read for assertions, which would otherwise silently kick the
watchdog every time a test looked at memory.

**Inputs are active high**, and named rather than numeric:

```js
const INPUT_BITS = Object.freeze({
  coin: ['in0', SW0.COIN1],  left: ['in0', SW0.P1_LEFT],
  fire: ['in0', SW0.P1_SHOOT], test: ['in0', SW0.TEST],
  start1: ['in1', SW1.START1], /* ... */
});
```

A set bit means *pressed* — see the TEST button check at `.asm:820-821`
(`bit 6,a` / `jp nz,$0000`: set means run the self test). `tapInput()` holds a
button for a few frames and releases it for a few more, because
`CHECK_IF_COIN_INSERTED` only counts a coin when the bit is set in the current or
previous sample **and** clear in the two before that — a single-frame blip landing
next to an old one is ignored.

DIP switches are set by meaning, not by bit pattern: `setDips({ coinage: '1c1p',
bonus: 7000, ships: 3 })`, with the encodings taken from the operating manual and
an unknown value throwing rather than silently doing something else.

**The frame engine** is where timing becomes behaviour:

```js
runFrame(observe = null) {
  const nmiAt = this.frameStart + VBLANK_START_CYCLE;   // 43008
  const end   = this.frameStart + CYCLES_PER_FRAME;     // 50688

  while (this.totalCycles < nmiAt) { if (observe && observe(this)) return true; this.stepCpu(); }
  if (this.nmiEnabled) { this.cpu.nmi(); this.nmiCount += 1; }
  while (this.totalCycles < end)   { if (observe && observe(this)) return true; this.stepCpu(); }

  this.frameStart = end;
  this.frames += 1;
  return false;
}
```

Master clock 18.432 MHz, CPU = master/6 = 3.072 MHz, 384 pixel clocks × 264 lines
= **50688 cycles per frame = 60.606 Hz**, with vblank — and therefore the NMI — at
cycle 43008, after the 224 visible lines. Two properties matter for the oracle:
the NMI fires **only if the `$7001` enable latch is set at that instant** (the
handler clears it on entry and sets it again on exit, so a slow frame genuinely
misses an interrupt, exactly as the board does), and **instruction overrun is
carried into the next frame** rather than discarded, so N frames really are
N × 50688 cycles give or take one instruction.

The `observe` callback runs before every instruction and stops the run mid-frame,
which is what makes precise sampling possible. Four helpers build on it:

| Helper | Use |
|--------|-----|
| `runUntil(pred, max)` | run frames until a predicate holds at a frame boundary |
| `runUntilPc(addr)` | stop with the CPU *about to execute* a given address |
| `tracePcs(frames)` | every PC visited, as a Set |
| `peekSymbol(name)` | read a RAM variable by its disassembly name |

`tracePcs` is how `test/unit/boot.test.mjs` proves the ROM never reaches its own
failure handlers during power-on — a stronger statement than "it looked fine".

### 2.3 `symbols.mjs` — the name table

153 entries mapping every documented RAM variable to its address, transcribed from
the EQU block at `.asm:190-627`, each carrying the disassembly line it came from:

```js
export const SYMBOLS = Object.freeze({
  /** $4005 -- 0-based index into pointer table beginning @ $00CE (.asm:218) */
  SCRIPT_NUMBER: 0x4005,
  /** $420D -- Direction of swarm (really? ;) ) 0 = Moving left, 1 = moving right . See $0945 (.asm:479) */
  SWARM_DIRECTION: 0x420d,
  /** $42B0 (.asm:625) */
  INFLIGHT_ALIENS: 0x42b0,
});
```

Two decisions here are deliberate. **The table is generated once and then frozen,
not derived at run time** — if someone edits the disassembly in a way that moves a
variable, the differential tests must fail loudly rather than silently follow it.
And **lookups go through the same address decoder the CPU sees**, so
`peekSymbol('PLAYER_LIVES')` and the ROM's own `ld a,($421D)` resolve identically,
mirrors and all.

The payoff shows up in failure messages. Because `src/machine/addresses.js` carries
the same names on the port's side, a lock-step failure reads:

```
frame 1029: SWARM_DIRECTION ($420D) oracle=$0 port=$1
```

rather than an anonymous byte offset — which is the difference between a five-minute
diagnosis and an afternoon of bisecting.



## 3. Lock-step differential testing

This is the headline test (`test/oracle/lockstep.test.mjs`). Both machines boot,
then step together:

```js
test('a coin, a start and 1200 frames of play stay byte-identical', () => {
  const { mach, port } = pair();
  ...
  // Wander and shoot, deterministically, so the run is reproducible.
  for (let i = 0; i < 1200; i += 1, frame += 1) {
    press('left',  (frame % 200) < 90);
    press('right', (frame % 200) >= 110);
    press('fire',  (frame % 23) < 3);
    stepAndCompare(mach, port, frame);
  }
});
```

`stepAndCompare` runs one frame on each side and then diffs **$4000-$43BF** — all of
the game's own variables. (The top of RAM is the Z80's stack; the port has no stack,
so those bytes are meaningless to compare.) A failure names the variable, not an
address:

```
frame 1029: SWARM_DIRECTION ($420D) oracle=$0 port=$1
```

### Getting the sampling point right

The subtle part is *when* to compare. Three things conspire against a naive
frame boundary:

* The NMI fires at cycle 43008 of 50688, so the handler routinely spills past the end
  of the hardware frame. Sampling on a frame boundary catches the ROM mid-handler.
* The real board's foreground loop drains the command queue *continuously* between
  interrupts, while the port drains it in one go. Sampling before the ring is empty
  catches the read pointer mid-drain.
* Arriving at the top of the foreground loop means the ROM is *about to* call
  `HANDLE_SWARM_ANIMATION`, not that it has.

So the oracle is settled to a precise, reproducible state: **handler finished, command
ring empty, and one further trip round the idle loop** (`PC == $200A`).

### Determinism is not luck

The game's only randomness is `GENERATE_RANDOM_NUMBER`, a `r = r*5 + 1 (mod 256)`
LCG seeded from whatever the power-on RAM test leaves behind. Period 256, visiting
every byte value — a shuffled counter rather than a random source. That is why alien
attack patterns feel varied but never truly random, and it is what makes byte-exact
lock-step possible at all.

### The rest of the oracle suite

Beyond lock-step, `test/oracle/` proves each subsystem in isolation by calling the
real ROM subroutine in the emulator and the JavaScript function with the same inputs:

| Test | Covers |
|------|--------|
| `subroutines.test.mjs` | `GENERATE_RANDOM_NUMBER`, `CALCULATE_TANGENT`, BCD, plotting |
| `attack.test.mjs` | who breaks formation, and when |
| `inflight.test.mjs` | the diving flight algorithms and arc tables |
| `bullets.test.mjs`, `bullets-render.test.mjs` | player and enemy shots |
| `collision.test.mjs` | exact hit boxes |
| `player.test.mjs`, `score.test.mjs`, `text.test.mjs` | movement, BCD scoring, strings |
| `render.test.mjs` | the renderer, fed by the real ROM's video memory |
| `latency.test.mjs` | that the port's one-frame display lag matches the board's |

`tools/shoot.mjs` and `tools/shoot-port.mjs` take that further: they render the
**original ROM's** character RAM and OBJRAM through `src/video/`, and then the port's,
so the pairs in `screenshots/` can be compared directly. If the ROM screenshots look
like Galaxian, the renderer is right; if the port's differ from them, the port is wrong.

---

## 4. Why the port keeps the original memory map

The port has no `Alien` class, no `Player` object, no component system. Game state
lives at the addresses the 1979 code used:

```js
export class Machine {
  /** Working RAM, 1 KB physical, mirrored across $4000-$47FF. */
  ram = new Uint8Array(REGION.RAM_SIZE);
  /** 32x32 tilemap, 1 KB, mirrored across $5000-$57FF. */
  charRam = new Uint8Array(REGION.CHAR_RAM_SIZE);
  /** Sprites, bullets, per-column scroll and colour; mirrored across $5800-$5FFF. */
  objRam = new Uint8Array(REGION.OBJ_RAM_SIZE);
```

Two things follow, and both are the whole point:

1. **The differential test is a byte comparison, not a judgement call.** If state
   lived in JavaScript objects, "does the port agree with the ROM?" would require a
   hand-written mapping, and that mapping would be where the bugs hid.
2. **Any line of the disassembly can be read straight against this code.** The port's
   writes go through the same address decoder the CPU sees, including the reads
   outside a decoded region that float high, and including the ROM routines whose
   pointer arithmetic walks clean out of character RAM (see the runaway loop in
   `DISPLAY_PLAYER_SHIPS_REMAINING`). On the real board those strays land in working
   RAM or hit ROM and are discarded; masking to character RAM instead would silently
   wrap them back onto the screen.

---

## 5. Z80 assembly vs. JavaScript, side by side

### 5.1 The random number generator

```asm
GENERATE_RANDOM_NUMBER:
003C: 3A 1E 40      ld   a,($401E)
003F: 47            ld   b,a
0040: 87            add  a,a
0041: 87            add  a,a
0042: 80            add  a,b
0043: 3C            inc  a
0044: 32 1E 40      ld   ($401E),a
0047: C9            ret
```

```js
export function generateRandomNumber(m) {
  const next = (m.peek(VAR.RAND_NUMBER) * 5 + 1) & 0xff;
  m.poke(VAR.RAND_NUMBER, next);
  return next;
}
```

`add a,a / add a,a / add a,b` is `×2, ×2, +original` — that is `×5`, done without a
multiply instruction. The `& 0xff` is doing the job the 8-bit accumulator did for free.

### 5.2 `CALCULATE_TANGENT` — eight steps of restoring division

Used to aim enemy bullets at the player, and to pick which of the 24 rotation frames
a diving alien is drawn in.

```asm
CALCULATE_TANGENT:
0048: 0E 00         ld   c,$00
004A: 06 08         ld   b,$08
004C: BA            cp   d
004D: 38 01         jr   c,$0050
004F: 92            sub  d
0050: 3F            ccf
0051: CB 11         rl   c
0053: CB 1A         rr   d
0055: 10 F5         djnz $004C
0057: C9            ret
```

```js
export function calculateTangent(a, d) {
  let numerator = a & 0xff;
  let divisor = d & 0xff;
  let quotient = 0;
  for (let step = 0; step < 8; step += 1) {
    let bit = 0;
    if (numerator >= divisor) { numerator = (numerator - divisor) & 0xff; bit = 1; }
    quotient = ((quotient << 1) | bit) & 0xff;
    divisor >>= 1;
  }
  return quotient;
}
```

Three things here are load-bearing, and all three were settled by the ROM rather than
by the prose specs:

* **The scale is 128, not 256.** The first quotient bit compares `a` against `d`
  itself, and after eight `rl c` shifts that bit carries weight 128 — so `a == d`
  yields 128, not 255. Both written specs originally claimed 256.
* **It runs slightly high.** `rr d` truncates the divisor toward zero every step, so
  each threshold is a little smaller than `d / 2^k` and bits set more readily; once
  the divisor reaches 0 every remaining comparison succeeds and the low bits fill with
  ones. This is why `calculateTangent(0, d)` returns a small non-zero value.
* **The `ccf` is what makes the quotient bit come out the right way round** — carry is
  *set* when the subtraction did not borrow.

Both quirks are in the original, and both shape enemy bullet aim and alien facing.

### 5.3 The frame handler

```asm
0066: F5            push af                  ; ... and bc, de, hl, ix, iy
006E: AF            xor  a
006F: 32 01 70      ld   ($7001),a           ; disable further NMIs until done
; update screen in one go - IMPORTANT
0079: 21 20 40      ld   hl,$4020            ; OBJRAM_BACK_BUF
007C: 11 00 58      ld   de,$5800            ; screen attribute RAM
007F: 01 80 00      ld   bc,$0080
0082: ED B0         ldir                     ; update screen & sprites in one go
0084: 3A 00 78      ld   a,($7800)           ; kick the watchdog
0087: 3A 15 40      ld   a,($4015)           ; shift the $6000 port history...
...
00B0: 21 5F 42      ld   hl,$425F            ; TIMING_VARIABLE
00B3: 35            dec  (hl)
00B4: CD EF 18      call $18EF               ; CHECK_IF_COIN_INSERTED
00B7: CD 31 19      call $1931               ; HANDLE_UNPROCESSED_COINS
00BD: CD F5 16      call $16F5               ; HANDLE_SOUND
00C0: CD 98 18      call $1898               ; HANDLE_SWARM_SOUND
00C3: CD C0 18      call $18C0               ; HANDLE_TEXT_SCROLL
00CA: 3A 05 40      ld   a,($4005)           ; SCRIPT_NUMBER
00CD: EF            rst  $28                 ; jump to SCRIPT_TABLE[A]
```

```js
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

  processCommandQueue(m, COMMAND_HANDLERS, handleSwarmAnimation);
}
```

The ordering is not cosmetic. **The sprite back buffer is copied to hardware first,
before any logic runs**, which is why what the player sees lags the simulation by one
frame — a property `test/oracle/latency.test.mjs` pins down. The `$6000` port history
is three frames deep specifically for coin edge detection.

### 5.4 The circular command queue

Galaxian has two threads of control: the vblank NMI runs the game logic, and a
foreground loop runs continuously in between, drawing. They talk through a 32-entry
ring at `$40C0`. The NMI *posts* a command and moves on; it never touches character
RAM itself.

```asm
PROCESS_CIRCULAR_COMMAND_QUEUE:
200A: 26 40         ld   h,$40
200C: 3A A1 40      ld   a,($40A1)           ; CIRC_CMD_QUEUE_PROC_LO
200F: 6F            ld   l,a
2010: 7E            ld   a,(hl)              ; read command number
2011: 87            add  a,a                 ; ×2 for the jump table at $203D
2012: 30 05         jr   nc,$2019            ; valid command? go dispatch it
2014: CD 67 20      call $2067               ; otherwise HANDLE_SWARM_ANIMATION
2017: 18 F1         jr   $200A
```

```js
export function queueCommand(m, command, parameter) {
  const lo = m.peek(VAR.CIRC_CMD_QUEUE_PTR_LO);
  const addr = 0x4000 | lo;
  // Only bit 7 is tested, so any value with the top bit set counts as free.
  if ((m.peek(addr) & 0x80) === 0) return false;

  m.poke(addr, command & 0xff);
  m.poke(0x4000 | ((lo + 1) & 0xff), parameter & 0xff);

  const next = (lo + 2) & 0xff;
  m.poke(VAR.CIRC_CMD_QUEUE_PTR_LO, next < QUEUE_START_LO ? QUEUE_START_LO : next);
  return true;
}
```

Two behaviours here are load-bearing and easy to miss:

* **A command posted to a full queue is silently dropped.** No retry, no log.
  Reachable under heavy queue pressure, and the port drops it too.
* **When the foreground loop finds the next slot empty it runs
  `HANDLE_SWARM_ANIMATION` instead.** That is the *only* thing that animates the
  formation — so the swarm's wing-flap is literally driven by queue idleness. The
  `add a,a / jr nc` is the test: a free slot holds `$FF`, doubling sets carry.

### 5.5 A routine that returns from its own caller

```asm
ASSERT_NOT_GAME_OVER:
0008: 3A 07 40      ld   a,($4007)           ; read IS_GAME_OVER
000B: 0F            rrca                     ; flag into carry
000C: D0            ret  nc                  ; not game over: return normally
000D: 33            inc  sp                  ; otherwise discard the caller's...
000E: 33            inc  sp                  ; ...return address
000F: C9            ret                      ; and return one level further up
```

`rst $08` sits in the middle of `DISPLAY_BOTTOM_OF_SCREEN`, and on a game-over it
**abandons the calling routine** by popping its return address off the stack. There is
no JavaScript control-flow construct for that, so the port spells out the effect:

```js
if (which === BOTTOM.SHIPS) {
  // $24C4 is `rst $08` -- ASSERT_NOT_GAME_OVER, which on a game-over pops the
  // caller's return address and abandons the routine.
  if ((m.peek(VAR.IS_GAME_OVER) & 1) !== 0) return;
  displayShipsRemaining(m, m.peek(VAR.PLAYER_LIVES));
  return;
}
```

Attract mode holds `IS_GAME_OVER` set the whole way through, which is why the demo
game never draws a spare-ship row — and why omitting this guard lets the blanking pass
at the tail of `DISPLAY_PLAYER_SHIPS_REMAINING` wipe the CREDIT line that shares those
character cells.

---

## 6. Video: the screen is sideways

The cabinet is `ROT90`. In raster space the visible area is 256 wide × 224 tall; on the
player's screen it is 224 × 256:

```
screenX = 239 - rasterY        rasterY in [16, 239]
screenY = rasterX              rasterX in [0, 255]
```

Everything unintuitive about the video code follows from that single transform:

* **The low five bits of a character RAM address select the screen *row*.** A tilemap
  "column" is a screen row. The disassembly's own header note gets this slightly
  wrong; `docs/video-sound.md` part 0 derives it from first principles and
  cross-validates it five ways.
* **Per-column scroll registers move screen rows horizontally.** This is how both the
  alien formation and the player's ship move sideways — **neither is a sprite.**
* Text runs left to right on screen by stepping the character RAM pointer *backwards*
  32 bytes at a time.
* Every 8×8 tile and 16×16 sprite is rotated 90° clockwise relative to ROM storage, so
  the ROM's X flip is a vertical flip on screen and its Y flip is a horizontal one.

Other hardware behaviours reproduced rather than approximated:

* **Sprites draw from 7 down to 0**, because the hardware's line buffer only accepts a
  write into a still-empty slot — the *lowest* numbered sprite wins.
* **The first three sprites match one scanline earlier than the rest**, a genuine
  board quirk the game compensates for when it writes those bytes.
* **Shells and missiles bypass the palette entirely.** The hardware ORs them into the
  RGB output after the colour lookup, which is why they are brighter than any tile.
  The bullet comparator fires where `(byte + V) & 0xFF == 0xFF`, so the raster line is
  `255 - byte`, and inactive bullets parked at 0 are culled by simply never being
  reached.

---

## 7. Input: keyboard and joystick

The board has no idea who closed a switch — `Machine.setInput` just sets a port
bit. That is fine while the keyboard is the only input, because a key event is
an **edge**: keydown closes the switch, keyup opens it, and nothing ever
re-asserts a switch already closed.

A joystick cannot work that way. The Gamepad API has no button events at all —
you call `navigator.getGamepads()` and get a snapshot — so it necessarily
asserts its whole state, pressed and unpressed alike, every frame. Writing that
straight through would stamp on an arrow key the player is holding, sixty times
a second.

`src/input/mux.js` is the fix, and the whole correctness argument is one
sentence: **each source owns a set of names it is holding, the switch is closed
if any source holds it, and a release only reaches the machine when none do.**
A source can therefore re-assert its full state as often as it likes for free.
The poll itself goes in `stepFrame()` immediately before `nmi()`, beside the
self-playing AI, for the same reason the AI is there — whatever closes a switch
this frame must do it before the machine samples its ports.

### Why there is a remapping screen

The Gamepad API only promises a fixed layout when it reports
`mapping: "standard"`. A no-name USB stick usually reports `mapping: ""` and
numbers its axes and buttons however its firmware felt like, so there is no
table of magic indices that works. Press `G` to bind left, right and fire.

The idea that makes this work on cheap hardware is that **a control is active
when it has moved away from where it rests, not when its value is large.** Worn
potentiometers idle at 0.2 or 0.3, and analogue triggers conventionally rest at
−1.0 and travel to +1.0 — so an untouched trigger reports the most extreme value
the API can express. Test the absolute value and that stick reads as "hard left,
forever"; test deviation from a rest position sampled while nobody was touching
it and both cases come out right with no per-device special-casing. Rest is
re-sampled when the page regains focus, because a pad can be moved while the tab
is in the background.

The same rule drives binding capture, which is how "press the control you want"
picks the right one out of six axes and sixteen buttons all reporting numbers
continuously. Rest is snapshotted the instant the prompt appears, so a button
still held down from the previous row is part of rest and cannot be captured
again — "release before binding the next one" falls out for free, with no timer
and no wait-for-release state.

Bindings are stored per device under a fingerprint of `id` plus the axis and
button counts, because `Gamepad.index` is only a connection slot and two no-name
sticks both reporting an empty `id` still need separate profiles.

**One thing a joystick cannot do is unlock the sound.** Browsers require a user
activation gesture before a page may make noise, and gamepad input does not
count — only keys, clicks and touches. Calling `sound.start()` from the poll loop
would produce a rejected promise every frame and no audio, so it is not called.
Coin and start being on the keyboard covers it in practice.

Everything except the DOM of the remapping screen is a pure function of plain
data, so the mux, the binding model, the capture algorithm and the polling layer
are all exercised in plain Node against a fake `navigator` — 64 tests, no
browser.

---

## 8. Sound: four voices of analogue circuitry

The board has **no sound CPU** — it is discrete analogue circuitry driven by ten latch
bits and an eight-bit pitch value. `src/game/sound.js` writes those latches exactly as
the ROM does; `src/audio/sound.js` watches them once per frame and synthesises a
comparable noise in WebAudio.

| Voice | What it is |
|-------|-----------|
| PITCH | A square tone at `1.536 MHz / (256 - pitch)`, divided by 8 (or 16 with VOL2). Melodies, the coin sweep, the extra-life beep and the diving-alien swoop all come out of this one oscillator — which is why they cut each other off in the original. |
| BACKGROUND | Three detuned square tones, enabled one per surviving alien up to three, swept by a shared LFO whose rate comes from a 4-bit DAC. The swarm hum, and the loudest voice. |
| FIRE | A short noisy chirp, gated for 8 frames. |
| HIT | Filtered noise with a slow decay: the player's death. |

The swarm "wow" is worth a note, because it is the thing a naive implementation gets
an octave wrong. MAME's netlist builds those three tones with `DISCRETE_555_ASTABLE_CV`
— 555 astables whose *control voltage* pin is driven by a shared VCO. The textbook
`f = 1.44 / ((R1 + 2·R2)·C)` only gives the frequency at rest. As the control voltage
is pulled down the charge time collapses while the discharge time does not:

```
t_high = (R1 + R2) · C · ln((Vcc - CV/2) / (Vcc - CV))
t_low  = R2 · C · ln(2)

R1 = 100k, R2 = 470k / 330k / 220k, C = 10nF:
  F1  138.7 Hz -> 254.5 Hz   (1.83x)
  F2  189.8 Hz -> 357.9 Hz   (1.89x)
  F3  267.2 Hz -> 525.8 Hz   (1.97x)
```

So the swarm hum is not a steady drone with a wobble on it: **each tone sweeps nearly
an octave, and that sweep is the "wow."**

Noise is sampled at 2V (7920 Hz) rather than per sample, which gives Galaxian's noise
its grainy rather than hissy texture.

---

## 9. Data and graphics are generated, never transcribed

Hand-copying 300-odd bytes of tables out of an 8000-line listing is a reliable way to
introduce a typo no reviewer will ever spot. So nothing is copied by hand:

* **`src/game/tables.js` is emitted by `tools/gen-tables.mjs`**, which reads the tables
  straight out of the verified ROM image at their documented addresses. The tables are
  correct by construction, and `test/unit/tables.test.mjs` re-checks the emitted file
  against the ROM so the two can never drift.
* **`src/video/{tiles,sprites,palette}.js` are emitted by `tools/gen-graphics.mjs`.**
  The program ROM contains no artwork — tiles, sprites and the colour PROM lived on
  separate chips. Their decoded contents come from Jean-François Fabre's open-source
  Galaxian port, vendored as `reference/galaxian_gfx.c` so the build is reproducible
  offline: 256 8×8 characters, 64 16×16 sprites, and 32 palette entries plus the two
  hardware bullet colours. Pixels are 2 bits, packed four to a byte and emitted as
  base64 — 4 KB per set instead of 50 KB of array literal.

---

## 10. What the lock-step actually caught

Six real fidelity bugs, each of which surfaced *only* because the comparison was
byte-exact:

1. **`CLEAR_ROW_OF_SCREEN` falls through into `SET_COLOUR_ATTRIBUTES_TABLE_1`.** It
   bumps the script stage and then runs straight into the next routine, so finishing
   the screen wipe also restores the in-game palette. Neither written spec mentions
   it. Without it the whole game ran in the wrong colours.
2. **The alien swoop's pitch is computed every frame; only the sweep runs at half
   rate.** Both had been gated on frame parity.
3. **That swoop's `rra` rotates in the carry from the preceding `add`, not a fixed 1.**
   Forcing bit 7 on put the warble an octave out.
4. **`HANDLE_START_BUTTONS` copies one 32-byte block, not the swarm and state
   separately** — and it sweeps eight bytes past the end of the player state. Those
   trailing bytes are literally `call $090D` / `call $098E` opcodes. The copy takes
   them anyway, so the port does too.
5. **The PUSH START BUTTON stage clears two rows per frame, not one.**
6. **`PLAYER_ONE_INIT` queues six commands, not five** — a one-player game draws its
   own score and the high score separately, where the port used the "all scores"
   variant.

And one genuine 1979 bug that the port must *reproduce* rather than fix: a diving blue
alien scores **70**, per `$22D4` (`70 00 00`), but the attract mode's own SCORE ADVANCE
TABLE advertises **60** for that same alien. The two written specs disagreed; the ROM
settled it. Correcting it would make every score diff against the oracle fail, so it is
documented, not fixed.

---

## 11. Repository layout

```
src/
  main.js              canvas, frame clock, input routing
  machine/
    machine.js         the board: RAM, mirrors, I/O decode, dip switches
    addresses.js       every RAM variable and block, by name
  game/                one module per subsystem of the original program
    script.js          the NMI handler and the SCRIPT state machine
    swarm.js  attack.js  inflight.js    formation, breaking away, diving
    player.js bullets.js collision.js   movement, shots, hit boxes
    score.js  text.js  plot.js  aliendraw.js  commands.js  tables.js  rng.js
    sound.js           writes the sound latches exactly as the ROM does
  video/
    renderer.js        tilemap, sprites, bullets, the 90-degree transform
    tiles.js sprites.js palette.js starfield.js
  audio/sound.js       WebAudio synthesis of the analogue sound board
  ai/autoplay.js       the self-playing AI

test/
  z80/                 the oracle: Z80 core, board, symbol table
  oracle/              differential tests against the original ROM
  unit/                ROM reconstruction, tables, boot, CPU core
  browser/selftest.html

tools/
  build-rom.mjs        reconstruct the ROM from the disassembly
  gen-tables.mjs       emit src/game/tables.js from the ROM
  gen-graphics.mjs     emit tiles/sprites/palette from the decoded artwork
  shoot.mjs            screenshot the ORIGINAL ROM through our renderer
  shoot-port.mjs       screenshot the PORT through the same renderer
  screenshots.mjs      both, into screenshots/, for direct comparison

reference/
  galaxian.asm         Scott Tunstall's annotated disassembly
  galaxian.rom         reconstructed image (generated; see npm run rom)
  galaxian_gfx.c       decoded tiles, sprites and palette

docs/
  game-rules.md        frame model, SCRIPT machine, player, bullets, collision,
                       scoring, difficulty — with a differential-testing appendix
  flight-algorithms.md how aliens break formation and dive
  video-sound.md       coordinates, tilemap, sprites, starfield, sound, attract AI
```

The self-playing AI in `src/ai/autoplay.js` is a *controller*, not a cheat: its only
output is the same three switches a human has. It cannot move faster than one pixel per
frame, cannot fire while a shot is in flight, and dies to exactly the same hit boxes.

---

## 12. Status and known divergences

The full suite is green (272 tests), and lock-step holds byte-for-byte through
attract mode and 1200 frames of played gameplay from a coin and a start. The
CONVOY CHARGER points page is compared frame by frame for its whole ~1950-frame
run — RAM, character RAM and OBJRAM alike.

Known gaps, stated plainly:

* **`SWARM_DIRECTION` diverges around frame 1029 of a long free-running attract
  session.** Lock-step's scripted runs do not reach it; a longer unattended comparison
  does. It shifts the swarm's horizontal position during the attract demo relative to
  the original. Not yet diagnosed.
* **`DISABLE_SWARM_ANIMATION` and `TIMING_VARIABLE` are wrong at attract stage
  12.** `$02EF` and `$02F2` both clear them; the port sets the former to 1 and
  never clears the latter. Found by extending the convoy-charger comparison past
  the end of the points page. Not yet fixed.
* Lock-step samples at a settled point once per frame. It does not compare
  *intra-frame* ordering, so a difference that exists only between the NMI and the
  next settle is invisible to it.

### Reproducing a divergence yourself

```sh
npm run test:oracle                 # the scripted lock-step runs
node tools/screenshots.mjs          # rom-*.png and port-*.png, same renderer
```

`test/oracle/convoy.test.mjs` is the template for reaching a part of the attract
mode lock-step never gets to: boot the oracle to the stage you care about, clone
it into a fresh port there, and compare every frame from that point. The blind
spot it closed had hidden a missing feature for the life of the project.

Put the matching pair side by side; anything that differs is a port bug, because the
ROM image, the CPU core and the renderer are shared between them.

---

## Credits

* **Scott Tunstall** — the annotated disassembly in `reference/galaxian.asm`, without
  which none of this exists.
* **The MAME team** — the Galaxian driver and its discrete sound netlist, which settled
  the timing and the analogue voices.
* **Namco**, 1979.

Galaxian is a trademark of its respective owner. 
