#!/usr/bin/env bash
set -euo pipefail

if ! command -v qmltestrunner >/dev/null 2>&1; then
  echo "qmltestrunner unavailable; run this check on Omarchy after installing the plugin"
  exit 77
fi

: "${OMARCHY_PATH:?Set OMARCHY_PATH to the Omarchy checkout}"
QML_IMPORT_PATH="$OMARCHY_PATH/shell${QML_IMPORT_PATH:+:$QML_IMPORT_PATH}" \
QT_QPA_PLATFORM=offscreen \
  qmltestrunner -input "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" -import "$OMARCHY_PATH/shell"
