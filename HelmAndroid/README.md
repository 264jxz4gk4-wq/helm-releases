# Helm for Android

Helm running entirely on an Android phone, tablet or TV box: connect to
Fire TV / Google TV / Android TV over Wi-Fi, pair, install apps, and manage
them, with no Mac or PC involved.

Built and tested for a **Galaxy Tab 3 7.0 (SM-T210R) on LineageOS** - 32-bit
ARM, Android 7, 1 GB RAM - and runs on anything from Android 5.0 up.

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

### What the build does to the shared UI

`tools/sync-ui.mjs` copies `../ui/index.html` into the APK and makes it safe
for old WebViews: it downlevels the JavaScript to Chrome 51 (Android 7's
original WebView) and adds polyfills for `NodeList.forEach` (tab switching),
`Object.entries` (device naming) and friends. It then **verifies** the result
parses as plain ES2015, that every function the HTML calls still exists, and
that no inline `onclick` uses newer syntax. Any failure stops the build.

It also fails if `ui/index.html` stops declaring
`const API = 'http://localhost:5001'`, since the Android server depends on it.

### Security model

Same rules as the patched desktop servers, plus loopback-only:

* binds `127.0.0.1` - nothing else on the network can reach it
* no CORS headers - the only client is the app's own WebView
* `Host` must be `localhost` or an IP literal, which blocks DNS rebinding
  from a web page open in the tablet's browser
* `/adb` only ever runs the bundled adb, and only allowlisted subcommands

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
adb -s <tablet-serial> logcat -s HelmService HelmServer HelmAdb HelmWeb
```

* `HelmService: bundled adb: exit=0 Android Debug Bridge version ...` -
  the bundled binary runs on this device. If the exit code isn't 0, see
  `ADB_BINARY.md`.
* `HelmWeb:` lines are the page's JavaScript console, including any errors.

## Known limits

* **Pairing connects on port 5555 afterwards**, same as the desktop app. On
  some TVs wireless debugging uses a *different* random port for the connect
  step (shown on the main Wireless debugging screen). The Android server
  already accepts an optional `connect_address` for this; the shared UI
  doesn't send it yet.
* On a very old WebView, CSS flex `gap` isn't supported, so some items sit
  closer together. Cosmetic only.
