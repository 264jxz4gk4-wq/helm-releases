# HelmIR: IR remote codes for Helm for Android

On a phone or tablet with an IR blaster (the Galaxy Tab 3, many Xiaomi
phones), the Remote page can work a TV over infrared, including turning it
on, which adb over Wi‑Fi can't do. This folder holds the code library behind
that and the test that verifies it.

| file | what it is |
|---|---|
| `ir.js` | `HelmIR`: protocol encoders and the TV code table. Plain ES5-compatible JavaScript. The UI carries a copy inline. |
| `inline.mjs` | Copies `ir.js` into `ui/index.html`. `--check` fails if the copy is stale; `sync-ui.mjs` runs that check on every Android build. |
| `test_ir.mjs` | Verifies every key of every set against independent references, and generates the code table. Exits 1 on any failure. |
| `_ref/` | Scripts that rebuild the pinned reference environment the test uses. Nothing in it ships. |

## Changing codes

```
sh _ref/fetch_refs.sh          # once: downloads and builds the references (needs git, curl, dpkg-deb, a JDK, gcc, node)
# edit SPEC in test_ir.mjs     (which source file and key each table entry comes from)
node test_ir.mjs --write-table # regenerate the table in ir.js from the sources
node test_ir.mjs               # all checks must pass (--coverage, --provenance, --verbose for more)
node inline.mjs                # copy ir.js into ui/index.html
```

Every value in the table is copied from a source file by `--write-table`; none
is typed by hand.

## How the app uses it

```js
HelmIR.keyPattern('tcl', 'tcl_gtv', 'power', { carriers, toggle: 'auto' })
  // -> { frequency: 38000, pattern: [4000, 4000, 500, 2000, ...] }   (microseconds, mark first)
HelmIR.powerCandidates('tcl')   // power codes to try, in order, during setup
```

The page sends `{frequency, pattern}` to Helm's local server (`POST /ir`),
and `IrBlaster.kt` checks it and hands it to Android's
`ConsumerIrManager.transmit()`. `carriers` is what the device reports from
`getCarrierFrequencies()`: Samsung blasters often accept only 30, 33, 36, 38,
40 and 56 kHz, so 38.4 kHz is sent as 38 kHz (well within a TV receiver's
tolerance).

Setup asks for the TV brand, then sends each of that brand's power codes until
the person says the TV reacted. If none work, it offers "alternate timing":
some Android 4.4 IR drivers read the pattern as carrier cycles instead of
microseconds, and `IrBlaster.kt` converts when asked.

## Coverage

12 brands, 27 code sets, 285 keys. Power, volume, mute, navigation, OK, back,
home and settings exist for every main set; a few sets are power-only
fallbacks tried during setup.

| brand | sets (main first) |
|---|---|
| TCL | Google TV / Android TV (RCA code, 38 kHz) · Roku TV · same power code at 56 kHz |
| Hisense | Google TV · VIDAA · Roku TV (power) · older RC5 (power) |
| Samsung | Samsung TV · 2016+ smart-remote power code |
| LG | webOS and older |
| Sony | Bravia (with discrete on/off) |
| Vizio | SmartCast |
| Philips | Android TV (RC6) · Roku TV · older RC5 |
| Panasonic | Viera |
| Sharp | Aquos (Sharp protocol) · newer EU Aquos · Roku TV (power, two variants) |
| Toshiba | Fire TV Edition · classic NEC · EU RC5 |
| Insignia | Fire TV Edition · NS-RC remotes · Roku TV (power) |
| Roku | Roku TV |

`node test_ir.mjs --coverage` prints the full key-by-key table, and
`--provenance` the exact source entry of every key.

## Sources

The shipped codes come only from **Flipper-IRDB**
(github.com/Lucaslhm/Flipper-IRDB, pinned at `d126fb1b`): numeric protocol,
address and command values, taken from parsed entries or from RAW captures
decoded with IrpTransmogrifier. Most of the files used predate that project's
CC0 grant; only the numeric codes (functional facts) are used, not the files.

Used only by the test, never shipped:

| reference | pinned | used for |
|---|---|---|
| IrpTransmogrifier (GPL-3.0) | `c945e763` | exact timing reference: every pattern must match its render within ±1 µs |
| Flipper Zero firmware `lib/infrared` (GPL-3.0) | `7f0b6e1c` | compiled for the host; defines what Flipper's address/command fields mean |
| probonopd/irdb | `11aa5eb3` | cross-database agreement checks |

## What the test checks

For each of the 285 keys, plus random fields per protocol:

- **src**: the table value equals the cited source entry.
- **irpt**: the pattern equals IrpTransmogrifier's render, duration by duration (±1 µs), same carrier.
- **fz**: the pattern matches what the Flipper firmware transmits for the same fields (±5%, same frame structure).
- **raw**: where real remote recordings exist, the pattern matches them.
- **xdb**: codes agree between Flipper-IRDB and irdb where both have them.
- **lim**: integer µs, odd length, starts with a mark, never over Android's 2-second limit.
- **es5**: `ir.js` transpiles for Android 4.4 and produces identical patterns.

The test was also run against deliberately broken copies of `ir.js` (bit
order, timing unit, frame count, carrier, a one-digit table typo and more) and
failed every time.

**Not verified**: no code has been sent to a real TV from this test. "Verified"
means the table matches the published captures and the encoder reproduces the
protocol definitions exactly. Whether a given TV reacts depends on the
capture it came from.

## Known uncertainties

- **TCL carrier**: every source records 38 kHz, but none measured it, so setup also tries the same power code at 56 kHz.
- **"Settings" key**: maps to each remote's menu/settings/options key, which behaves differently per brand.
- **Hisense Google TV**: remotes disagree on home, menu and play/pause; the 2023 55U6K values are used.
- **Insignia Fire TV**: only power was captured on an Insignia remote; the rest are Amazon Fire TV Edition codes, which Toshiba Fire TV captures agree with.
- **Roku TV power fallbacks** for Hisense, Sharp and Insignia assume all Roku TVs share one code set (captured for TCL, onn. and Philips).

## Protocol notes

Field meanings follow Flipper's parsed `.ir` files (little-endian bytes), so
new Flipper files can be added without conversion. Timings and carriers come
from IrpTransmogrifier's protocol database, with one deliberate change: the
RCA unit is 500 µs, not 460, because TCL's remotes measure exactly 500 µs
(and Flipper's encoder uses 500).

| protocol | one press sends |
|---|---|
| NEC, NECext, Samsung32, Kaseikyo, RC5/RC5X, RC6, RCA/RCA56 | 1 frame |
| SIRC, SIRC15, SIRC20 (Sony) | 3 frames: Sony TVs need at least 3 |
| Sharp | a frame plus its inverted-command check frame |

RC5/RC6 TVs ignore a press whose toggle bit equals the previous one; the UI
passes `toggle: 'auto'`.
