#!/usr/bin/env bash
# Download the adb binaries bundled in Helm for Android, verify them against
# pinned SHA-256 checksums, and put them where Gradle packages them.
#
#   armeabi-v7a  lzhiyong/android-sdk-tools 35.0.2 (android-sdk-tools-static-arm.zip):
#                adb built from AOSP with the NDK, static, ARMv7-A + VFPv3 + NEON.
#                Proven on Android 4.4 (Galaxy Tab 3).
#   arm64-v8a    Helm's own build, release adb-35.0.2-16k-8 on this repo, made by
#                .github/workflows/build-adb.yml from tools/build-adb.sh: the same
#                AOSP sources and recipe, built with NDK r27c so it also runs on
#                phones with 16 KB memory pages. Static, no interpreter.
#
# If a file ever changes, the checksum fails and this script stops. That is
# the point: we never ship a binary nobody looked at. See ADB_BINARY.md.
#
# Usage (from HelmAndroid/):  bash tools/fetch-adb.sh
set -euo pipefail

LZY="https://github.com/lzhiyong/android-sdk-tools/releases/download/35.0.2"
HELM="https://github.com/264jxz4gk4-wq/helm-releases/releases/download/adb-35.0.2-16k-8"

# abi-dir | download URL | file inside the zip ("" if the URL is the binary) | sha256 of adb
TARGETS=(
  "armeabi-v7a|$LZY/android-sdk-tools-static-arm.zip|platform-tools/adb|3e63e36500259c2044e08632fe56552300d8e22e3bcd8f083d74a7f2c8ae6ec1"
  "arm64-v8a|$HELM/adb-arm64-v8a||02c97d5ed8d90becff5ce43e09fa0117237f4e9b469621281b9da07db8c28517"
)

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for t in "${TARGETS[@]}"; do
  IFS='|' read -r abi url member want <<<"$t"
  dest="$here/app/src/main/jniLibs/$abi/libadb.so"

  if [[ -f "$dest" && "$(sha256 "$dest")" == "$want" ]]; then
    echo "ok      $abi (already present, checksum verified)"
    continue
  fi

  echo "fetch   $abi <- $url"
  mkdir -p "$work/$abi"
  if [[ -n "$member" ]]; then
    curl -fsSL --retry 3 -o "$work/$abi/download.zip" "$url"
    unzip -q -o -j "$work/$abi/download.zip" "$member" -d "$work/$abi"
    bin="$work/$abi/$(basename "$member")"
  else
    bin="$work/$abi/adb"
    curl -fsSL --retry 3 -o "$bin" "$url"
  fi

  got="$(sha256 "$bin")"
  if [[ "$got" != "$want" ]]; then
    echo "FAILED  $abi checksum mismatch" >&2
    echo "        expected $want" >&2
    echo "        got      $got" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dest")"
  cp "$bin" "$dest"
  chmod 755 "$dest"
  echo "ok      $abi (sha256 verified)"
done
