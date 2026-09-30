#!/usr/bin/env bash
# Download the adb binaries bundled in Helm for Android, verify them against
# pinned SHA-256 checksums, and put them where Gradle packages them.
#
# Source: lzhiyong/android-sdk-tools 35.0.2 - adb built from AOSP with the
# Android NDK, statically linked against bionic (no shared-library
# dependencies). Checked before pinning:
#   arm:     ELF32 ARM, ARMv7-A + VFPv3 + NEON, static, no interpreter
#   aarch64: ELF64 AArch64, static, no interpreter
#
# If upstream ever changes a file, the checksum fails and this script stops.
# That is the point: we never ship a binary nobody looked at.
#
# Usage (from HelmAndroid/):  bash tools/fetch-adb.sh
set -euo pipefail

VERSION="35.0.2"
BASE="https://github.com/lzhiyong/android-sdk-tools/releases/download/${VERSION}"

# abi-dir | release-arch | sha256 of the extracted adb binary
TARGETS=(
  "armeabi-v7a|arm|3e63e36500259c2044e08632fe56552300d8e22e3bcd8f083d74a7f2c8ae6ec1"
  "arm64-v8a|aarch64|da34ede1747352d93aff56e5132a943c0f67a5c5b3d0896ea77d3eb315923f1b"
)

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for t in "${TARGETS[@]}"; do
  IFS='|' read -r abi arch want <<<"$t"
  dest="$here/app/src/main/jniLibs/$abi/libadb.so"

  if [[ -f "$dest" && "$(sha256 "$dest")" == "$want" ]]; then
    echo "ok      $abi (already present, checksum verified)"
    continue
  fi

  echo "fetch   $abi <- android-sdk-tools-static-$arch.zip"
  curl -fsSL --retry 3 -o "$work/$arch.zip" "$BASE/android-sdk-tools-static-$arch.zip"
  unzip -q -o -j "$work/$arch.zip" platform-tools/adb -d "$work/$arch"

  got="$(sha256 "$work/$arch/adb")"
  if [[ "$got" != "$want" ]]; then
    echo "FAILED  $abi checksum mismatch" >&2
    echo "        expected $want" >&2
    echo "        got      $got" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dest")"
  cp "$work/$arch/adb" "$dest"
  chmod 755 "$dest"
  echo "ok      $abi (sha256 verified)"
done
