#!/usr/bin/env bash
# Apply Hector's runtime guard to every web engine in a completed dist bundle.
#
# Usage:
#   scripts/web/apply-hector-protection.sh [DIST_DIR]
#
# Environment:
#   HECTOR_ROOT=/path/to/hector/protect  Hector workspace (default: local checkout)
#   HECTOR_KEY=/path/to/server.key       Key whose .pub half is used by the live server
#   HECTOR_WS_URL=wss://.../ws           Production or test guard endpoint
#   PROTECT_DEBUG=1                      Build Hector's diagnostic guard variant
#
# Run this after scripts/web/make-dist.sh and before a local smoke test or
# deployment. It changes only DIST_DIR; source WASM and build artifacts remain
# untouched. Build manifests stay in a temporary directory and are never
# deployed.
#
# GeneralsX @build caiiiycuk 21/08/2026 Add testable Hector protection stage.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="${1:-$REPO_ROOT/web/dist}"
HECTOR_ROOT="${HECTOR_ROOT:-/home/caiiiycuk/gamepix/hector/protect}"
HECTOR_KEY="${HECTOR_KEY:-$HECTOR_ROOT/server.key}"
HECTOR_WS_URL="${HECTOR_WS_URL:-wss://hector.dos.zone/ws}"
WORK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

[[ -d "$DIST_DIR" ]] || fail "dist directory not found: $DIST_DIR"
[[ -x "$HECTOR_ROOT/protect.sh" ]] || fail "HECTOR_ROOT does not contain protect.sh: $HECTOR_ROOT"
[[ -f "$HECTOR_KEY" && -f "$HECTOR_KEY.pub" ]] ||
    fail "Hector key pair is missing: $HECTOR_KEY and $HECTOR_KEY.pub"
command -v wasm-tools >/dev/null || fail "wasm-tools is required to validate protected modules"

case "$HECTOR_WS_URL" in
    ws://*|wss://*) ;;
    *) fail "HECTOR_WS_URL must start with ws:// or wss://" ;;
esac
[[ "$HECTOR_WS_URL" != *$'\n'* && "$HECTOR_WS_URL" != *$'\r'* ]] ||
    fail "HECTOR_WS_URL must not contain a line break"

engines=()
for engine in GeneralsXZH GeneralsX; do
    wasm="$DIST_DIR/$engine.wasm"
    glue="$DIST_DIR/$engine.js"
    if [[ -f "$wasm" || -f "$glue" ]]; then
        [[ -f "$wasm" && -f "$glue" ]] || fail "$engine requires both $wasm and $glue"
        engines+=("$engine")
    fi
done
[[ ${#engines[@]} -gt 0 ]] || fail "no web engines found in $DIST_DIR"

for engine in "${engines[@]}"; do
    # The currently deployed Hector injector has an explicit single-threaded,
    # no-EH contract. GeneralsX requires a shared pthread memory for its
    # blocking engine loop and emits native wasm exception tags, so fail before
    # spending time building the guard or ever publishing an unguarded module.
    if rg -q 'shared:true' "$DIST_DIR/$engine.js"; then
        fail "$engine is a pthread/shared-memory module; the installed Hector injector does not support thread-safe guards"
    fi
    if wasm-tools objdump "$DIST_DIR/$engine.wasm" | rg -q '^[[:space:]]*tags[[:space:]]'; then
        fail "$engine uses wasm exception tags; the installed Hector injector cannot merge exception-enabled modules"
    fi

    echo "==> Hector: $engine"
    engine_work="$WORK_DIR/$engine"
    mkdir -p "$engine_work"

    KEY="$HECTOR_KEY" "$HECTOR_ROOT/protect.sh" \
        "$DIST_DIR/$engine.wasm" \
        "$DIST_DIR/$engine.js" \
        "$engine_work/$engine.wasm"

    # Emscripten emits legacy exception instructions; validate the complete
    # browser feature set instead of wasm-tools' conservative default.
    wasm-tools validate --features all "$engine_work/$engine.wasm"
    [[ -f "$engine_work/gc.js" ]] || fail "Hector did not generate gc.js for $engine"
done

# Do not leave stale clients from an older engine layout in the bundle.
rm -rf "$DIST_DIR/hector"
for engine in "${engines[@]}"; do
    install -d "$DIST_DIR/hector/$engine"
    install -m 0644 "$WORK_DIR/$engine/$engine.wasm" "$DIST_DIR/$engine.wasm"
    install -m 0644 "$WORK_DIR/$engine/gc.js" "$DIST_DIR/hector/$engine/gc.js"
done

escaped_ws_url="${HECTOR_WS_URL//\\/\\\\}"
escaped_ws_url="${escaped_ws_url//\"/\\\"}"
printf 'window.gxHectorEnabled = true;\nwindow.gxHectorWsUrl = "%s";\n' "$escaped_ws_url" \
    > "$DIST_DIR/hector-config.js"
perl -0pi -e 's|<script src="game\.js"></script>|<script src="hector-config.js"></script>\n<script src="game.js"></script>|' \
    "$DIST_DIR/index.html"

rg -q 'src="hector-config\.js"' "$DIST_DIR/index.html" ||
    fail "could not enable Hector bootstrap in $DIST_DIR/index.html"
echo "==> Hector protection ready: $DIST_DIR"
