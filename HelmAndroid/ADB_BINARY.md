# The bundled adb binary

Helm for Android ships a real `adb`, compiled to run **on** Android, as
`jniLibs/<abi>/libadb.so`. `tools/fetch-adb.sh` downloads it at build time and
verifies it against pinned SHA-256 checksums; it is not committed to git.

## Source

[lzhiyong/android-sdk-tools](https://github.com/lzhiyong/android-sdk-tools)
release **35.0.2** - AOSP adb built with the Android NDK.

| ABI | Release file | SHA-256 of `adb` |
|---|---|---|
| `armeabi-v7a` | `android-sdk-tools-static-arm.zip` | `3e63e36500259c2044e08632fe56552300d8e22e3bcd8f083d74a7f2c8ae6ec1` |
| `arm64-v8a` | `android-sdk-tools-static-aarch64.zip` | `da34ede1747352d93aff56e5132a943c0f67a5c5b3d0896ea77d3eb315923f1b` |

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

Pick a new release, download both zips, extract `platform-tools/adb`, repeat
the checks above (`file`, `readelf -d`, `readelf -A`), then update `VERSION`
and both checksums in `tools/fetch-adb.sh` and the table above.

## Licence

adb is part of AOSP and licensed Apache-2.0; it statically includes BoringSSL
and other open-source libraries. See `THIRD_PARTY_NOTICES.md`.
