#!/usr/bin/env bash
# GeneralsX Web - assemble the deployable static bundle.
#
# Iterates over all builds in web/gamedata/ (e.g. default_ru), packs each
# into dist/assets/{build}/, copies the wasm shell once, and writes build.json.
#
# dist/
#   index.html, loader.js, storage.js, signaling.js, game.js,
#   coi-serviceworker.js   <- COOP/COEP injector for bare static hosts
#   ice.json               <- EDITABLE: STUN/TURN + MQTT brokers
#   GeneralsXZH.js, GeneralsXZH.wasm
#   build.json             <- {buildId: "xxxx"}
#   assets/
#     builds.json           <- ["default_ru", ...]
#     default_ru/
#       manifest.json
#       files/...
#
# Creates:
#   scripts/web/pack-assets.sh {build}   (once per build)
#
# Usage:
#   scripts/web/make-dist.sh [--skip-assets] [WASM_DIR]
#
# GeneralsX @build web-port 05/07/2026 - Web port Phase 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKIP_ASSETS=false
if [ "${1:-}" = "--skip-assets" ]; then
    # GeneralsX @build Lolendor 22/07/2026 Refresh the web shell without repacking game data.
    SKIP_ASSETS=true
    shift
fi
WASM_DIR="${1:-$REPO_ROOT/build/emscripten/GeneralsMD}"
DIST="$REPO_ROOT/web/dist"

if [ ! -f "$WASM_DIR/GeneralsXZH.wasm" ]; then
    echo "ERROR: $WASM_DIR/GeneralsXZH.wasm not found - build first:" >&2
    echo "  cmake --preset emscripten && cmake --build build/emscripten --target z_generals" >&2
    exit 1
fi

mkdir -p "$DIST"

# ── Shell ─────────────────────────────────────────────────────────────────────
echo "==> Shell"
cp "$REPO_ROOT"/web/shell/*.js "$REPO_ROOT"/web/shell/index.html "$DIST/"
mkdir -p "$DIST/i18n"
cp -R "$REPO_ROOT/web/shell/i18n/." "$DIST/i18n/"
cp "$REPO_ROOT"/web/shell/brotli_bg.wasm "$DIST/"   # brotli-wasm decoder blob
if [ ! -f "$DIST/ice.json" ]; then
    cp "$REPO_ROOT/web/shell/ice.json" "$DIST/"
else
    echo "    dist/ice.json exists - keeping your edited version"
fi

# ── Wasm build ────────────────────────────────────────────────────────────────
echo "==> Wasm build"
cp "$WASM_DIR/GeneralsXZH.js" "$WASM_DIR/GeneralsXZH.wasm" "$DIST/"
# GeneralsX @build caiiiycuk 14/08/2026 Base Generals web build (?game=generals):
# built as a sibling target (Generals/GeneralsX.*); optional so a ZH-only
# build tree still produces a working dist.
BASE_WASM_DIR="$(dirname "$WASM_DIR")/Generals"
if [ -f "$BASE_WASM_DIR/GeneralsX.wasm" ]; then
    cp "$BASE_WASM_DIR/GeneralsX.js" "$BASE_WASM_DIR/GeneralsX.wasm" "$DIST/"
    echo "    + base Generals engine (GeneralsX.js/.wasm)"
else
    echo "    (no base Generals wasm at $BASE_WASM_DIR - ?game=generals will not work)"
fi
BUILD_ID=$(cat "$DIST/GeneralsXZH.wasm" "$DIST/GeneralsX.wasm" 2>/dev/null | shasum -a 256 | cut -c1-12)
printf '{"buildId": "%s"}\n' "$BUILD_ID" > "$DIST/build.json"
echo "    buildId: $BUILD_ID"

if $SKIP_ASSETS; then
    # GeneralsX @tweak caiiiycuk 14/08/2026 Torrent-deploy model: dist may
    # legitimately carry no packed assets — create an empty index instead of failing.
    if [ ! -f "$DIST/assets/builds.json" ]; then
        mkdir -p "$DIST/assets"
        echo '[]' > "$DIST/assets/builds.json"
        echo "==> Assets: none packed — wrote empty assets/builds.json (--skip-assets)"
    else
        echo "==> Assets: keeping existing packed game data (--skip-assets)"
    fi
    echo "==> Done: $DIST"
    exit 0
fi

# ── Discover builds (directories under web/gamedata/) ─────────────────────────
BUILDS=()
for d in "$REPO_ROOT/web/gamedata"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ -n "$name" ] || continue
    BUILDS+=("$name")
done

if [ ${#BUILDS[@]} -eq 0 ]; then
    echo "ERROR: no builds found in $REPO_ROOT/web/gamedata/" >&2
    exit 1
fi

echo "==> Buildings (${#BUILDS[@]}): ${BUILDS[*]}"

# ── Pack each build ──────────────────────────────────────────────────────────
for name in "${BUILDS[@]}"; do
    echo "  -> $name"
    "$REPO_ROOT/scripts/web/pack-assets.sh" "$name"
done

# ── Builds index ──────────────────────────────────────────────────────────────
printf '[\n' > "$DIST/assets/builds.json"
first=true
for name in "${BUILDS[@]}"; do
    $first || printf ',\n' >> "$DIST/assets/builds.json"
    data="$DIST/assets/$name/build.data"
    sz=0; fc=0
    if [ -f "$data" ]; then
        sz=$(stat -f%z "$data" 2>/dev/null || stat -c%s "$data" 2>/dev/null || echo 0)
    fi
    printf '  {"name":"%s","size":%d}' "$name" "$sz" >> "$DIST/assets/builds.json"
    first=false
done
printf '\n]\n' >> "$DIST/assets/builds.json"

echo "==> Done: $DIST"
echo "    Builds: ${BUILDS[*]}"
echo "    Upload the directory to any HTTPS host, or serve locally:"
echo "    cd web && go run ./server -dir ./dist            # http://localhost:8080"
echo "    cd web && go run ./server -dir ./dist -tls-self-signed   # https://<ip>:8080"
