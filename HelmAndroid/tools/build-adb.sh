#!/usr/bin/env bash
# Build a static adb for arm64 Android whose ELF layout works on devices with
# 16 KB memory pages (an Android 15+ option some new phones ship with), and
# verify it. Run by .github/workflows/build-adb.yml; output goes to <work>/out.
#
# Why build it: the prebuilt arm64 adb Helm used (lzhiyong/android-sdk-tools
# 35.0.2) is linked for 4 KB pages - its code and data segments share 16 KB
# pages - and embeds a C library from an NDK that assumes 4 KB pages, so it
# cannot run on a 16 KB-page kernel. Patching the file can't fix either.
#
# Recipe: lzhiyong/android-sdk-tools 35.0.2 (CMake build of AOSP's
# platform-tools-35.0.2 sources, with its patches), built with NDK r27c,
# statically linked, -z max-page-size=16384 and flexible page sizes on.
#
# The 32-bit armeabi-v7a adb is NOT rebuilt: 16 KB pages only exist on 64-bit
# devices, and the existing 32-bit binary is proven on a real Android 4.4 tablet.
#
# Usage: build-adb.sh <workdir>
set -uo pipefail

WORK="${1:?usage: build-adb.sh <workdir>}"
LZY_TAG="35.0.2"                     # lzhiyong/android-sdk-tools tag
AOSP_TAG="platform-tools-35.0.2"     # AOSP sources
NDK_VERSION="27.2.12479018"          # NDK r27c
ABI="arm64-v8a"
API=30                               # build.py's minimum

mkdir -p "$WORK/out" "$WORK/logs"
OUT="$WORK/out"; LOGS="$WORK/logs"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

# Run a phase with its output logged. On failure, surface the end of the log
# as an Actions annotation (readable on the run page without log access).
phase() {
  local name="$1"; shift
  echo "::group::$name"
  local log="$LOGS/$(echo "$name" | tr ' /' '__').log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    tail -n 5 "$log"; echo "::endgroup::"
    echo "- ✅ $name ($((SECONDS - start))s)" >> "$SUMMARY"
    return 0
  fi
  tail -n 80 "$log"; echo "::endgroup::"
  # The first error lines say why; the tail says where it stopped. Both go in
  # the annotation, which is readable on the run page without log access.
  local errs tailtext
  errs="$(grep -E -m 12 'error:|Error:|FAILED:|fatal|No such file|not found' "$log" | cut -c1-300)"
  tailtext="$(grep -v '^\s*$' "$log" | tail -n 12 | cut -c1-300)"
  printf '%s\n--- last lines ---\n%s\n' "$errs" "$tailtext" | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}' > "$LOGS/annotation.txt"
  echo "::error title=$name failed::$(cat "$LOGS/annotation.txt")"
  echo "- ❌ $name failed" >> "$SUMMARY"
  exit 1
}

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$SDK" ] || { echo "::error::ANDROID_HOME not set"; exit 1; }
NDK="$SDK/ndk/$NDK_VERSION"

install_ndk() {
  if [ ! -f "$NDK/source.properties" ]; then
    # Not `yes | sdkmanager` under pipefail: `yes` dies of SIGPIPE when
    # sdkmanager exits, which fails the pipeline even when the install worked.
    # sdkmanager redraws its progress bar with \r; turn those into lines.
    printf 'y\ny\ny\ny\ny\n' | "$SDK/cmdline-tools/latest/bin/sdkmanager" --install "ndk;$NDK_VERSION" 2>&1 | tr '\r' '\n' | grep -v '^\s*$' | tail -n 40
  fi
  [ -f "$NDK/source.properties" ] || { echo "NDK $NDK_VERSION not installed; have: $(ls "$SDK/ndk" 2>&1)"; return 1; }
  grep Pkg.Revision "$NDK/source.properties"
}
host_tools() {
  sudo apt-get update -qq && sudo apt-get install -y -qq ninja-build cmake qemu-user-static
}
get_sources() {
  git clone -c advice.detachedHead=false --depth 1 --branch "$LZY_TAG" \
    https://github.com/lzhiyong/android-sdk-tools.git "$WORK/sdk-tools" &&
  cd "$WORK/sdk-tools" && python3 get_source.py --tags "$AOSP_TAG"
}
# The recipe ships patches that get_source.py doesn't apply ("we may need to
# patch manually"). adb needs two: protobuf's CMake include paths (without it
# the host protoc fails on a missing config.h) and openscreen's task runner
# (adb's mDNS code). The rest are for aapt2/dexdump.
apply_patches() {
  cd "$WORK/sdk-tools" || return 1
  local p=protobuf_CMakeLists.txt.patch
  echo "== $p"
  if patch -p1 --forward --batch --dry-run < "patches/$p" >/dev/null 2>&1; then
    patch -p1 --forward --batch < "patches/$p" || return 1
  elif patch -p1 --reverse --batch --dry-run < "patches/$p" >/dev/null 2>&1; then
    echo "already applied"
  else
    echo "does not apply:"; patch -p1 --forward --batch --dry-run < "patches/$p"; return 1
  fi

  # task_runner.h.patch was made for an older openscreen and no longer
  # applies as a diff. What it does: make Task a plain
  # std::packaged_task<void()>, since the noexcept variant doesn't compile with
  # the NDK's libc++ under -fno-exceptions. Do that by content instead.
  local f=src/openscreen/platform/api/task_runner.h
  echo "== $f"
  [ -f "$f" ] || { echo "missing"; return 1; }
  sed -i 's/std::packaged_task<void() noexcept>/std::packaged_task<void()>/g' "$f" || return 1
  grep -n "packaged_task" "$f"
  # (A comment in the file quotes the old error text, so match the declaration.)
  if grep -c "Task = std::packaged_task<void() noexcept>" "$f" >/dev/null; then echo "noexcept Task still present"; return 1; fi
}
host_protoc() {
  cd "$WORK/sdk-tools" &&
  cmake -S src/protobuf -B build-protoc -GNinja -Dprotobuf_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release &&
  ninja -C build-protoc protoc
}
configure() {
  local protoc
  protoc="$(find "$WORK/sdk-tools/build-protoc" -maxdepth 1 -type f -name 'protoc*' -perm -u+x | head -1)"
  [ -n "$protoc" ] || { echo "host protoc not found"; return 1; }
  echo "host protoc: $protoc"
  cd "$WORK/sdk-tools" &&
  cmake -GNinja -B build-arm64 \
    -DANDROID_NDK="$NDK" \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_PLATFORM="android-$API" \
    -DCMAKE_ANDROID_ARCH_ABI="$ABI" -DANDROID_ABI="$ABI" \
    -DCMAKE_SYSTEM_NAME=Android \
    -Dprotobuf_BUILD_TESTS=OFF -DABSL_PROPAGATE_CXX_STD=ON -DANDROID_ARM_NEON=ON \
    -DCMAKE_BUILD_TYPE=Release \
    -DPROTOC_PATH="$protoc" \
    -DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON \
    -DCMAKE_EXE_LINKER_FLAGS="-static -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
}
build_adb() {
  cd "$WORK/sdk-tools" && ninja -C build-arm64 adb
}
collect() {
  local bin
  bin="$(find "$WORK/sdk-tools/build-arm64" -type f -name adb -perm -u+x | head -1)"
  [ -n "$bin" ] || { echo "adb binary not found in build tree"; return 1; }
  cp "$bin" "$OUT/adb-$ABI" &&
  "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" "$OUT/adb-$ABI" &&
  ls -la "$OUT/adb-$ABI"
}

# Refuse to publish anything that isn't exactly what we need.
verify() {
  local f="$OUT/adb-$ABI"
  # grep -c, not grep -q: under pipefail, -q exiting at the first match can
  # kill the writer with SIGPIPE and turn a match into a failure.
  file "$f"
  file "$f" | grep -c "ARM aarch64" >/dev/null || { echo "not an aarch64 binary"; return 1; }
  if readelf -d "$f" 2>/dev/null | grep -c NEEDED >/dev/null; then echo "dynamically linked; must be static"; return 1; fi
  python3 - "$f" <<'EOF' || return 1
import subprocess, sys
PAGE = 0x4000
rows = [l.split() for l in subprocess.run(["readelf", "-lW", sys.argv[1]], capture_output=True, text=True).stdout.splitlines()
        if l.strip().startswith("LOAD")]
ok, segs = True, []
for r in rows:
    off, vaddr, memsz, align = int(r[1], 16), int(r[2], 16), int(r[5], 16), int(r[-1], 16)
    flags = "".join(x for x in r[6:-1])
    print(f"LOAD off={off:#x} vaddr={vaddr:#x} memsz={memsz:#x} flags={flags} align={align:#x}")
    if align % PAGE:
        ok = False; print("  -> alignment is not a multiple of 16 KB")
    if off % PAGE != vaddr % PAGE:
        ok = False; print("  -> file offset and address not congruent modulo 16 KB")
    segs.append((vaddr, vaddr + memsz, flags))
for (a0, a1, f1), (b0, b1, f2) in zip(segs, segs[1:]):
    if f1 != f2 and (a1 - 1) // PAGE >= b0 // PAGE:
        ok = False; print(f"  -> segments with different permissions share a 16 KB page at {b0 // PAGE * PAGE:#x}")
print("16 KB layout:", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
EOF
  echo "--- runs (under qemu) ---"
  qemu-aarch64-static "$f" version | tee "$LOGS/version.txt"
  grep -q "Android Debug Bridge version" "$LOGS/version.txt" || { echo "binary did not run"; return 1; }
  strings "$f" | grep -c "SPAKE2" >/dev/null || { echo "pairing (SPAKE2) support missing"; return 1; }
  echo "pairing support: present"
}

describe() {
  local sha; sha="$(sha256sum "$OUT/adb-$ABI" | cut -d' ' -f1)"
  echo "$sha  adb-$ABI" > "$OUT/adb-$ABI.sha256"
  {
    echo "Static adb for arm64 Android, compatible with 16 KB memory pages."
    echo
    echo "- sources: AOSP \`$AOSP_TAG\` via lzhiyong/android-sdk-tools \`$LZY_TAG\`"
    echo "- NDK: \`$NDK_VERSION\` (r27c), API $API, static, \`-z max-page-size=16384\`, flexible page sizes"
    echo "- built by: ${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-local}"
    echo "- verified: static, aarch64, 16 KB-aligned LOAD segments, runs (\`$(head -1 "$LOGS/version.txt")\`), pairing support"
    echo
    echo "sha256 \`$sha\`"
  } > "$OUT/NOTES.md"
  cat "$OUT/NOTES.md" >> "$SUMMARY"
  echo "::notice title=adb built::sha256 $sha"
}

phase "Install NDK $NDK_VERSION" install_ndk
phase "Host tools" host_tools
phase "Fetch AOSP sources" get_sources
phase "Apply recipe patches" apply_patches
phase "Build host protoc" host_protoc
phase "Configure" configure
phase "Build adb" build_adb
phase "Collect binary" collect
phase "Verify binary" verify
describe
