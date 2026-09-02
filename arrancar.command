#!/bin/bash

cd "$(dirname "$0")" || exit 1

NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="/Users/origds/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi

if [ ! -x "$NODE_BIN" ]; then
  echo "No se ha encontrado Node.js."
  read -r -p "Pulsa Intro para cerrar..."
  exit 1
fi

exec "$NODE_BIN" scripts/dev.mjs
