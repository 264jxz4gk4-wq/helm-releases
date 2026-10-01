# Third-party software in Helm for Android

**adb** (Android Debug Bridge) - Android Open Source Project, Apache License 2.0.
Bundled as statically linked binaries: the 32-bit one built by
lzhiyong/android-sdk-tools, the 64-bit one built by this project from the same
sources and recipe (tools/build-adb.sh). Their static link includes components under their own licences, among them
BoringSSL (OpenSSL / ISC), Protocol Buffers (BSD-3-Clause), Zstandard
(BSD-3-Clause), LZ4 (BSD-2-Clause), Brotli (MIT), Open Screen (BSD-3-Clause,
used for mDNS discovery) and libusb (LGPL-2.1).
Source: https://android.googlesource.com/platform/packages/modules/adb

**NanoHTTPD** 2.3.1 - BSD-3-Clause. https://github.com/NanoHttpd/nanohttpd

**Conscrypt** 2.5.2 - Apache License 2.0, including BoringSSL (OpenSSL / ISC).
Used only on Android 4.4, for modern HTTPS. https://github.com/google/conscrypt

**Kotlin standard library** - Apache License 2.0.

**Mozilla's root certificate list** (`res/raw/cacerts.pem`, as packaged by
certifi) - Mozilla Public License 2.0. Added to the device's own roots on
Android 7.1 and older so HTTPS downloads work there.
https://github.com/certifi/python-certifi

**Lucide icons** (in the UI) - ISC License, Copyright (c) 2026 Lucide Icons and
Contributors; some icons derive from Feather, MIT License, Copyright (c)
2013-present Cole Bemis. The full notices are in the UI source.
https://lucide.dev

**IR codes** (in the UI's HelmIR table) - numeric protocol, address and
command values taken from remote captures in Flipper-IRDB.
https://github.com/Lucaslhm/Flipper-IRDB
