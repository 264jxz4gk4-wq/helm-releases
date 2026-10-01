# The bundled adb binary

Helm for Android ships a real `adb`, compiled to run **on** Android, as
`jniLibs/<abi>/libadb.so`. `tools/fetch-adb.sh` downloads it at build time and
verifies it against pinned SHA-256 checksums; it is not committed to git.

## Source

Both are AOSP adb **35.0.2** (`platform-tools-35.0.2`), built with the
Android NDK and statically linked.

| ABI | Built by | Download | SHA-256 of `adb` |
|---|---|---|---|
| `armeabi-v7a` | [lzhiyong/android-sdk-tools](https://github.com/lzhiyong/android-sdk-tools) 35.0.2 | `android-sdk-tools-static-arm.zip` | `3e63e36500259c2044e08632fe56552300d8e22e3bcd8f083d74a7f2c8ae6ec1` |
| `arm64-v8a` | this repo: `tools/build-adb.sh`, run by `.github/workflows/build-adb.yml` | release [`adb-35.0.2-16k-8`](https://github.com/264jxz4gk4-wq/helm-releases/releases/tag/adb-35.0.2-16k-8) | `02c97d5ed8d90becff5ce43e09fa0117237f4e9b469621281b9da07db8c28517` |

### Why the 64-bit adb is our own build

Some newer phones run Android with 16 KB memory pages instead of 4 KB (an
Android 15+ option). lzhiyong's 64-bit adb can't run on them: its code and
data share 16 KB pages, and its static C library comes from an NDK that
assumed 4 KB pages. Neither can be patched in the file.

`tools/build-adb.sh` rebuilds it from the same AOSP sources with lzhiyong's
CMake recipe and patches, but with NDK r27c (whose C library supports 16 KB
pages), flexible page sizes and `-z max-page-size=16384`. It refuses to
publish unless the result is static, aarch64, 16 KB-aligned with no page
shared between segments of different permissions, runs (under qemu, also
with 16 KB pages) and includes pairing support. `adb version` reports
`Android Debug Bridge version 1.0.41`, `Version 35.0.3-`.

The 32-bit adb stays lzhiyong's: 16 KB pages exist only on 64-bit devices,
and that binary is proven on Android 4.4 (Galaxy Tab 3).

`tools/verify-apk.sh` checks every 64-bit native file in each release APK for
the 16 KB layout. Conscrypt's 64-bit library is left out of the APK (it is
only used on Android 4.4, which never runs on 64-bit devices), so 64-bit
Helm ships adb alone.

## What was checked before pinning

* **Fully static** - no dynamic section and no program interpreter, so it has
  no shared-library dependencies and doesn't care what the device ships.
  (Termux's adb, by contrast, links against Termux's own libraries and won't
  run inside another app.)
* **Built against bionic**, Android's C library - not glibc or musl.
* **32-bit build targets ARMv7-A with VFPv3 and NEON**, which is exactly what
  the Galaxy Tab 3's Marvell PXA988 (Cortex-A9) provides.
* **Pairing support compiled in** (`adb pair`, TLS + SPAKE2).

## Why it's called libadb.so

Since Android 10, apps can't execute files from their own data directory.
The one app-private directory that is always executable is
`nativeLibraryDir`, and Android only extracts files named `lib*.so` into it.
So the executable is renamed, `android:extractNativeLibs="true"` plus
`useLegacyPackaging = true` make sure it's extracted, and `AdbManager` runs it
from there. LADB uses the same technique.

## Quick check that it runs on a device

Before installing Helm on a new kind of device, you can test the binary alone:

```bash
adb -s <serial> push app/src/main/jniLibs/armeabi-v7a/libadb.so /data/local/tmp/adb
adb -s <serial> shell chmod 755 /data/local/tmp/adb
adb -s <serial> shell /data/local/tmp/adb version
```

A version string means it runs. Once Helm is installed, the same result
appears in logcat as `HelmService: bundled adb: exit=0 ...`.

## Updating it

32-bit: pick a new lzhiyong release, extract `platform-tools/adb` from the
arm zip, repeat the checks above (`file`, `readelf -d`, `readelf -A`), then
update the URL and checksum in `tools/fetch-adb.sh` and the table above.

64-bit: change the tags at the top of `tools/build-adb.sh`, run the "Build adb
for Android" workflow (Actions tab, or the API), and pin the new release's
URL and the checksum it reports in `tools/fetch-adb.sh` and the table above.

## Licence

adb is part of AOSP and licensed Apache-2.0; it statically includes BoringSSL
and other open-source libraries. See `THIRD_PARTY_NOTICES.md`.
