#!/bin/sh
D=$(cd "$(dirname "$0")" && pwd)
J=$D/deb/x/usr/share/java
exec java -cp "$D/irpt/build/irptransmogrifier.jar:$J/antlr4-runtime-4.9.2.jar:$J/jcommander-1.71.jar:$D/irpref" IrpRef "$@" 2> /dev/null
