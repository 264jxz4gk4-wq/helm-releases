#!/bin/sh
D=$(cd "$(dirname "$0")" && pwd)
J=$D/deb/x/usr/share/java
exec java -cp "$D/irpt/build/irptransmogrifier.jar:$J/antlr4-runtime-4.9.2.jar:$J/jcommander-1.71.jar:$J/antlr4-4.9.2.jar:$J/stringtemplate4.jar:$J/antlr3-runtime-3.5.3.jar:$J/treelayout.jar" org.harctoolbox.irp.IrpTransmogrifier "$@"
