#!/bin/bash
# Helm for Mac installer. Paste this into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/install-mac.sh | bash
#
# Picks the build for this Mac's chip, puts Helm in Applications and opens it.
# An app installed this way doesn't get macOS's "cannot be opened because
# Apple cannot check it" warning: that warning comes from the quarantine
# flag browsers put on downloads, and curl doesn't add it.
set -e
REPO=264jxz4gk4-wq/helm-releases

# Apple Silicon? (Checked with sysctl: a Terminal running under Rosetta
# reports x86_64 from uname even on an Apple Silicon Mac.)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  ZIP=HelmMac.zip; CHIP="Apple Silicon"
else
  ZIP=HelmMacIntel.zip; CHIP="Intel"
fi

DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Helm for $CHIP Macs..."
curl -fL --progress-bar -o "$TMP/helm.zip" "https://github.com/$REPO/releases/latest/download/$ZIP"
unzip -q "$TMP/helm.zip" -d "$TMP"
if [ ! -d "$TMP/Helm.app" ]; then
  echo "The download didn't contain Helm.app. Please try again later."
  exit 1
fi

killall Helm 2>/dev/null || true
rm -rf "$DEST/Helm.app"
mv "$TMP/Helm.app" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/Helm.app" 2>/dev/null || true

echo "Helm is installed in $DEST. Opening it now..."
open "$DEST/Helm.app"
