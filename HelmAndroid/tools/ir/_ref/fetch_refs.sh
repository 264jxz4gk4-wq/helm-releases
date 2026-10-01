#!/bin/sh
# Rebuild the reference environment used by ../test_ir.mjs, pinned to the commits the codes were taken from.
# Needs: git, curl, dpkg-deb, java+javac (JDK 11+), gcc, node/npm. Everything lands in this directory.
#   sh fetch_refs.sh            (idempotent; skips steps whose output already exists)
set -eu
cd "$(dirname "$0")"
R=$(pwd)

FLIPPER_IRDB_SHA=d126fb1b6f1e114c52b4a8c19839ea65e3a9c24d   # github.com/Lucaslhm/Flipper-IRDB (CC0-1.0)
FZ_SHA=7f0b6e1c14431708cfde75ae1ba13df59e868041             # github.com/flipperdevices/flipperzero-firmware (GPL-3.0)
IRDB_SHA=11aa5eb3ad9fec9e5c03f170c29c1467733d9f3e           # github.com/probonopd/irdb (custom licence; test cross-checks only, nothing shipped)
IRPT_SHA=c945e7638355ca5697f458d33338ee1bfd4d1640           # github.com/bengtmartensson/IrpTransmogrifier (GPL-3.0)

pin() { # dir url sha sparse-patterns...
  d=$1 u=$2 s=$3; shift 3
  if [ ! -d "$d/.git" ]; then
    git init -q "$d" && git -C "$d" remote add origin "$u"
    git -C "$d" config extensions.partialClone origin
    git -C "$d" sparse-checkout set --no-cone "$@"
    git -C "$d" fetch -q --depth 1 --filter=blob:none origin "$s"
    git -C "$d" checkout -q FETCH_HEAD
  fi
  echo "$d @ $(git -C "$d" rev-parse HEAD)"
}
pin flipper-irdb https://github.com/Lucaslhm/Flipper-IRDB "$FLIPPER_IRDB_SHA" '/TVs/' '/LICENSE' '/README.md'
pin fz https://github.com/flipperdevices/flipperzero-firmware "$FZ_SHA" '/lib/infrared/' '/applications/main/infrared/resources/' '/LICENSE'
pin irdb https://github.com/probonopd/irdb "$IRDB_SHA" '/codes/TCL/' '/codes/RCA/TV/' '/codes/Roku/' '/codes/Samsung/TV/' '/codes/LG/TV/' \
  '/codes/Sony/TV/' '/codes/Vizio/' '/codes/Philips/TV/' '/codes/Panasonic/TV/' '/codes/Sharp/TV/' '/codes/Toshiba/TV/' '/codes/Insignia/' '/LICENSE.md' '/README.md'
pin irpt https://github.com/bengtmartensson/IrpTransmogrifier "$IRPT_SHA" '/*'

# --- Java deps from Ubuntu 24.04 (noble) archive (Maven Central was not reachable from the build sandbox)
mkdir -p deb
for f in a/antlr4/antlr4_4.9.2-2_all.deb a/antlr4/libantlr4-runtime-java_4.9.2-2_all.deb j/jcommander/libjcommander-java_1.71-4_all.deb \
         s/stringtemplate4/libstringtemplate4-java_4.0.8-2.1_all.deb a/antlr3/libantlr3-runtime-java_3.5.3-2_all.deb \
         a/abego-treelayout/libtreelayout-java_1.0.3-2_all.deb; do
  b=deb/$(basename "$f"); [ -f "$b" ] || curl -sSf -o "$b" "http://archive.ubuntu.com/ubuntu/pool/universe/$f"
  dpkg-deb -x "$b" deb/x
done
J=$R/deb/x/usr/share/java
CP=$J/antlr4-4.9.2.jar:$J/antlr4-runtime-4.9.2.jar:$J/antlr3-runtime-3.5.3.jar:$J/stringtemplate4.jar:$J/treelayout.jar:$J/jcommander-1.71.jar

# --- IrpTransmogrifier: ANTLR parser + stub Version.java + CommandHelp stub (JCommander 1.71 lacks a 1.72+ API used only by 'help')
if [ ! -f irpt/build/irptransmogrifier.jar ]; then
  rm -rf irpt/build && mkdir -p irpt/build/gen/org/harctoolbox/irp irpt/build/classes
  java -cp "$CP" org.antlr.v4.Tool -o irpt/build/gen/org/harctoolbox/irp -package org.harctoolbox.irp -visitor -listener -Xexact-output-dir irpt/src/main/antlr4/org/harctoolbox/irp/Irp.g4
  cp irpt_patches/Version.java irpt/build/gen/org/harctoolbox/irp/
  (find irpt/src/main/java irpt/build/gen -name '*.java' | grep -v cmdline/CommandHelp.java; echo irpt_patches/CommandHelp.java) > irpt/build/sources.txt
  javac -nowarn -encoding UTF-8 -cp "$CP" -d irpt/build/classes @irpt/build/sources.txt
  cp irpt/src/main/resources/IrpProtocols.xml irpt/build/classes/
  (cd irpt/build/classes && jar cf ../irptransmogrifier.jar .)
fi
javac -nowarn -cp "irpt/build/irptransmogrifier.jar:$J/antlr4-runtime-4.9.2.jar" -d irpref irpref/IrpRef.java

# --- Flipper firmware infrared encoders/decoders compiled for the host
S=fz/lib/infrared/encoder_decoder
gcc -O1 -w -std=gnu11 -Ifzhost/stub -I$S -I$S/common -o fzhost/fzhost fzhost/fzhost.c $S/infrared.c $S/common/*.c \
  $S/nec/*.c $S/samsung/*.c $S/rc5/*.c $S/rc6/*.c $S/sirc/*.c $S/kaseikyo/*.c $S/rca/*.c $S/pioneer/*.c

# --- Babel (ES5 transpile check)
if [ ! -d babel/node_modules/@babel/core ]; then
  mkdir -p babel && (cd babel && [ -f package.json ] || echo '{"name":"helmir-babel-check","private":true}' > package.json; \
    npm install --no-audit --no-fund @babel/core@7 @babel/preset-env@7 acorn@8)
fi
echo "reference environment ready"
