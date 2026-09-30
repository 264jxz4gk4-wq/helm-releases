# Third-party software in Helm for Android

**adb** (Android Debug Bridge) - Android Open Source Project, Apache License 2.0.
Bundled as a statically linked binary built by lzhiyong/android-sdk-tools. Its
static link includes components under their own licences, among them
BoringSSL (OpenSSL / ISC), Protocol Buffers (BSD-3-Clause), Zstandard
(BSD-3-Clause), LZ4 (BSD-2-Clause), Brotli (MIT), Open Screen (BSD-3-Clause,
used for mDNS discovery) and libusb (LGPL-2.1).
Source: https://android.googlesource.com/platform/packages/modules/adb

**NanoHTTPD** 2.3.1 - BSD-3-Clause. https://github.com/NanoHttpd/nanohttpd

**AndroidX** (core, appcompat) - Apache License 2.0.

**Kotlin standard library** - Apache License 2.0.

**ISRG Root X1** certificate - Internet Security Research Group, bundled so
HTTPS downloads from Let's Encrypt-hosted mirrors work on Android 7.0.
