#!/bin/bash
# Installs the Volumio Remote applet and/or desklet for Cinnamon from this repository.
# Usage: ./install.sh [applet|desklet|both]   (default: both)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon"
WHAT="${1:-both}"

install_one() {   # type uuid
    local type="$1" uuid="$2" kind
    mkdir -p "$DEST/${type}s"
    rm -rf "$DEST/${type}s/$uuid"
    cp -r "$HERE/${type}s/$uuid/files/$uuid" "$DEST/${type}s/"
    echo "Installed $type $uuid"
    kind=$(echo "$type" | tr a-z A-Z)
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.ReloadXlet "$uuid" "$kind" >/dev/null 2>&1 || true
}

case "$WHAT" in applet|both)  install_one applet volumio@amystikis ;; esac
case "$WHAT" in desklet|both) install_one desklet volumio-desklet@amystikis ;; esac

echo
echo "Now add 'Volumio Remote' from  Applets (panel)  and/or  Desklets (desktop),"
echo "then open its settings and enter your Volumio IP / host name."
echo "If it is not listed, restart Cinnamon (Ctrl+Alt+Esc) or log out and in."
