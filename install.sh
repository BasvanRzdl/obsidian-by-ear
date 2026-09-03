#!/usr/bin/env bash
# Build and drop the plugin into a vault. Obsidian Sync then carries it to the iPad and phone,
# which is the only practical way to test mobile without a developer account.
#
#   ./install.sh                       # installs into the default vault below
#   ./install.sh "/path/to/OtherVault"
set -euo pipefail

VAULT="${1:-$HOME/Documents/Villanova Junction}"
DEST="$VAULT/.obsidian/plugins/by-ear"

[ -d "$VAULT/.obsidian" ] || { echo "Not an Obsidian vault: $VAULT" >&2; exit 1; }

npm run build
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"

echo "Installed to $DEST"
echo "In Obsidian: Settings -> Community plugins -> refresh, then enable 'By Ear'."
