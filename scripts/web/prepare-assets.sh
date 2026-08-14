#!/usr/bin/env bash
# GeneralsX Web - stage a named build into a reference directory (no packing).
#
# Performs the same preparation steps as pack-assets.sh but leaves the result
# as a plain directory tree that mirrors the OPFS root layout the engine
# expects — a deployer can copy it into OPFS verbatim, no re-arranging needed.
#
# Reads:
#   web/gamedata/{BUILD_NAME}/GeneralsZH/
#   web/gamedata/{BUILD_NAME}/Generals/      (optional base game)
#
# Produces (mirrors the OPFS root — the game keeps everything under
# ccgenerals/, see GX_OPFS_BASE in WebMain.cpp and storage.js):
#   {OUT_DIR}/                               (default: web/staging/{BUILD_NAME})
#     ccgenerals/GameData/                   (Zero Hour: *.big, Data/**, Maps/**)
#     ccgenerals/GameData/fonts/             (TrueType faces for the engine)
#     ccgenerals/GameDataGenerals/           (base Generals, if present)
#
# Usage:
#   scripts/web/prepare-assets.sh BUILD_NAME [OUT_DIR]
#
# GeneralsX @build caiiiycuk 24/07/2026
set -euo pipefail

BUILD="${1:?usage: prepare-assets.sh BUILD_NAME [OUT_DIR]}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATADIR="$REPO_ROOT/web/gamedata/$BUILD"
OUTDIR="${2:-$REPO_ROOT/web/staging/$BUILD}"

if [ ! -d "$DATADIR" ]; then
    echo "ERROR: build directory not found: $DATADIR" >&2
    exit 1
fi

GAMEBASE="$OUTDIR/ccgenerals"
mkdir -p "$GAMEBASE/GameData"

# Copy ZH data -> GameData/ (the engine's working directory in OPFS)
ZH="$DATADIR/GeneralsZH"
if [ -d "$ZH" ]; then
    echo "==> Zero Hour: $ZH"
    rsync -am --delete --delete-excluded \
        --filter='protect fonts' \
        --filter='protect fonts/**' \
        --exclude='.DS_Store' \
        --exclude='Thumbs.db' \
        --exclude='Data/Backup Scripts/' \
        --include='*/' \
        --include='*.big' \
        --include='Data/**' \
        --include='Maps/**' \
        --exclude='*' \
        "$ZH/" "$GAMEBASE/GameData/"
fi

# Copy base Generals data -> GameDataGenerals/ (an OPFS sibling of GameData/,
# so the engine's recursive primary *.big scan of GameData/ never picks it up)
BASE="$DATADIR/Generals"
if [ -d "$BASE" ]; then
    echo "==> Base Generals: $BASE"
    rsync -am --delete --delete-excluded \
        --filter='protect fonts' \
        --filter='protect fonts/**' \
        --exclude='.DS_Store' \
        --exclude='Thumbs.db' \
        --exclude='Data/Backup Scripts/' \
        --include='*/' \
        --include='*.big' \
        --include='Data/**' \
        --include='Maps/**' \
        --exclude='*' \
        "$BASE/" "$GAMEBASE/GameDataGenerals/"
fi

# ── Fonts ─────────────────────────────────────────────────────────────────────
# The engine resolves TrueType faces from fonts/ under its CWD (/opfs/ccgenerals/GameData).
# The game ships no .ttf files, so stage them: prefer a fonts/ dir shipped with
# the build, else download the metric-compatible Liberation fonts.
echo "==> Staging fonts"
FONTS_DIR="$GAMEBASE/GameData/fonts"
mkdir -p "$FONTS_DIR"
if [ -d "$ZH/fonts" ]; then
    rsync -a "$ZH/fonts/" "$FONTS_DIR/"
elif [ -d "$BASE/fonts" ]; then
    rsync -a "$BASE/fonts/" "$FONTS_DIR/"
elif [ -x "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" ]; then
    GX_FONTS="$FONTS_DIR" "$REPO_ROOT/scripts/build/ios/stage-fonts.sh" || true
fi
if [ ! -f "$FONTS_DIR/arial.ttf" ]; then
    echo "WARNING: no fonts staged — game text will not render" >&2
fi

# The base game runs with GameDataGenerals/ as its CWD and resolves fonts/
# from there too — mirror the staged set so ?game=generals renders text.
if [ -d "$GAMEBASE/GameDataGenerals" ]; then
    rsync -a "$FONTS_DIR/" "$GAMEBASE/GameDataGenerals/fonts/"
fi

echo "==> Done: $OUTDIR"
