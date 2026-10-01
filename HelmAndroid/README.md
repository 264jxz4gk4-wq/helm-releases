# Helm for Android

Helm running entirely on an Android phone, tablet or TV box: connect to
Fire TV / Google TV / Android TV over Wi-Fi, pair, install apps, and manage
them, with no Mac or PC involved.

Built for a **Galaxy Tab 3 7.0 (SM-T210R) on CyanogenMod 11** - Android 4.4.4,
32-bit ARM, 1 GB RAM - and runs on anything from **Android 4.4 KitKat** up.

## Install

Download `Helm.apk` from the
[latest release](https://github.com/264jxz4gk4-wq/helm-releases/releases/latest),
open it, and allow installs from unknown sources when asked.

Or from a computer with the tablet plugged in:

```bash
adb -s <tablet-serial> install -r Helm.apk
```

## How it works

```
  MainActivity (WebView)  ->  http://localhost:5001
                                     |
                             HelmServer (NanoHTTPD, loopback only)
                                     |
                             AdbManager  ->  libadb.so  ->  TV on your Wi-Fi
```

The UI is the desktop app's `ui/index.html`. It hardcodes
`const API = 'http://localhost:5001'`, so serving it from a loopback server on
that port makes every `fetch()` work untouched. **One UI for Mac, Windows and
Android** - a change to `ui/index.html` ships to all three on the next push.

`libadb.so` is a real adb binary (see `ADB_BINARY.md`), so Android 11+
wireless-debugging pairing works exactly as it does on the desktop.

### IR blaster

On a device with an infrared transmitter (the Galaxy Tab 3, many Xiaomi
phones), the Remote page can also work the TV over IR, including turning it
on, which adb can't do once the TV is off. The UI asks `GET /ir` whether the
device has one (only when it's running in an Android WebView), walks the
person through picking their TV's code set by trying power codes, then sends
each button as `POST /ir {frequency, pattern}`. `IrBlaster.kt` checks the
request and passes it to `ConsumerIrManager.transmit()`.

The codes and protocol encoders live in `tools/ir/` (`ir.js`, carried inline
in the UI), with a test that checks every key against independent references.
See `tools/ir/README.md`.

### What the build does to the shared UI

`tools/sync-ui.mjs` copies `../ui/index.html` into the APK as two builds, and
`HelmServer` serves one per request based on the WebView's Chrome version:

* **`index.html`** (Chrome 51+, Android 7 and newer): JavaScript downleveled
  with esbuild, plus polyfills for `NodeList.forEach` (tab switching) and
  `Object.entries` (device naming). Verified to parse as ES2015.
* **`index-legacy.html`** (Chrome 30-50, Android 4.4-6; `tools/legacy.mjs`):
  Android 4.4's WebView is Chromium 30-33 and can never be updated. The
  JavaScript is compiled to ES5 with Babel; the polyfills are exactly the
  core-js modules Babel detects the UI using, plus `fetch`. CSS variables and
  8-digit hex colours are resolved and `-webkit-` prefixes added. Because
  `applyTheme()` recolours the UI per device by setting CSS variables, a small
  shim re-renders the stylesheet in place from a template when it does.
  Verified to parse as ES5.

Both builds also check that every function the HTML calls still exists and
that no inline `onclick` uses syntax the target can't run, and that the UI's
inline copy of the IR library matches `tools/ir/ir.js`. Any failure stops
the build. In testing, the legacy build rendered pixel-identical to the
desktop UI with `fetch`, `Promise`, `Symbol`, `Object.assign` and
`NodeList.forEach` deleted from the page first.

It also fails if `ui/index.html` stops declaring
`const API = 'http://localhost:5001'`, since the Android server depends on it.

### Downloads on old Android

Android 4.4 can't talk to most current HTTPS servers (TLS 1.2 off by default,
no modern ciphers, outdated root certificates). `Tls.kt` fixes that for APK
downloads: on 4.4 it uses Conscrypt 2.5.2 (the last release supporting
pre-Lollipop) for TLS 1.2/1.3, and on Android 7.1 and older it adds Mozilla's
current root list (`res/raw/cacerts.pem`, via certifi) to the device's own
roots. Android 8+ uses the system unchanged.

### Security model

Same rules as the patched desktop servers, plus loopback-only:

* binds `127.0.0.1` - nothing else on the network can reach it
* no CORS headers - the only client is the app's own WebView
* `Host` must be `localhost` or an IP literal, which blocks DNS rebinding
  from a web page open in the tablet's browser
* POSTs must be JSON (`Content-Type: application/json`) and, when the browser
  sends an `Origin`, come from `http://localhost:5001`, which blocks cross-site
  form posts from a web page
* `/adb` only ever runs the bundled adb, and only the subcommands the UI uses
  (`connect`, `disconnect`, `devices`, `get-state`, `shell`, `uninstall`,
  `reboot`, `version`): nothing that reads or writes this device's files
* `/ir` only accepts a carrier between 15 and 100 kHz and a pattern of at most
  1024 durations totalling 2 seconds or less

## Building

CI does this on every push to `main` (see `.github/workflows/build.yml`) and
attaches a signed `Helm.apk` to the release. To build locally:

```bash
cd HelmAndroid
npm ci --prefix tools          # once
node tools/sync-ui.mjs         # after any change to ../ui/index.html
bash tools/fetch-adb.sh        # once; downloads + checksum-verifies adb
./gradlew assembleRelease      # or open HelmAndroid/ in Android Studio
```

The Gradle build refuses to start if the UI or adb binaries are missing, so
you can't accidentally produce an APK that installs and then does nothing.

## Signing

Android refuses to install an unsigned APK, and only accepts an update
signed with the **same key** as the installed app. CI signs with Helm's
release key from these repository secrets:

| Secret | Contents |
|---|---|
| `HELM_KEYSTORE_B64` | the PKCS12 keystore, base64 |
| `HELM_KEYSTORE_PASSWORD` | keystore password |
| `HELM_KEY_ALIAS` | `helm` |
| `HELM_KEY_PASSWORD` | key password (same as keystore) |

Release certificate SHA-256 (CI refuses to publish anything else):

```
7F:FE:3D:03:DF:52:1E:99:A4:06:13:17:33:09:E6:CB:E6:C6:C0:68:48:A4:B5:B7:9F:3E:17:9D:0E:DE:89:2E
```

The master copy of the key lives in `../.signing/` on the maintainer's Mac
(git-ignored). **Back it up.** If it's lost, existing installs can't be
updated - users would have to uninstall and reinstall.

Local builds without the secrets fall back to the debug key: fine for
testing, but that APK can't update a release install (uninstall first).

## Troubleshooting on the device

Everything logs to logcat. With the tablet plugged into a computer:

```bash
adb -s <tablet-serial> logcat -s HelmService HelmServer HelmAdb HelmWeb HelmIr
```

* `HelmService: bundled adb: exit=0 Android Debug Bridge version ...` -
  the bundled binary runs on this device. If the exit code isn't 0, see
  `ADB_BINARY.md`.
* `HelmService: IR blaster: {"available":true,...}` - whether the device has
  an IR transmitter, and which carrier frequencies it accepts.
* `HelmWeb:` lines are the page's JavaScript console, including any errors.

## Known limits

* **Pairing connects on port 5555 afterwards**, same as the desktop app. On
  some TVs wireless debugging uses a *different* random port for the connect
  step (shown on the main Wireless debugging screen). The Android server
  already accepts an optional `connect_address` for this; the shared UI
  doesn't send it yet.
* IR codes come from published remote captures and have been checked against
  protocol references, but only codes someone has tried on their own TV are
  known to work on that model. If no code works on an Android 4.4 device,
  "Try alternate timing" in the IR setup covers IR drivers that count carrier
  cycles instead of microseconds.
