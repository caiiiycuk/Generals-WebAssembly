#!/bin/bash
# GeneralsX @build caiiiycuk 24/07/2026 Copy runtime libs into a local gamedata dir and launch GeneralsXZH from it.
# Usage: ./scripts/build/linux/run-gamedata-zh.sh [game_dir] [-- extra game args]
# Default game_dir: gamedata/default_ru/GeneralsZH

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build/linux64-deploy"

GAME_DIR="${1:-${PROJECT_ROOT}/gamedata/default_ru/GeneralsZH}"
shift 2>/dev/null || true

if [[ ! -d "${GAME_DIR}" ]]; then
    echo "ERROR: Game dir not found: ${GAME_DIR}"
    exit 1
fi

BINARY="${BUILD_DIR}/GeneralsMD/GeneralsXZH"
if [[ ! -f "${BINARY}" ]]; then
    echo "ERROR: Binary not found: ${BINARY}"
    echo "Build first: cmake --build build/linux64-deploy --target z_generals"
    exit 1
fi

echo "==> Deploying binary and libraries to ${GAME_DIR}"
cp -f "${BINARY}" "${GAME_DIR}/"

# DXVK (dlopen'ed as libdxvk_d3d8.so — needs unversioned symlink)
cp -a "${BUILD_DIR}"/_deps/dxvk-src/lib/libdxvk_*.so* "${GAME_DIR}/"
for lib in d3d8 d3d9 dxgi d3d11 d3d10core; do
    if [[ -f "${GAME_DIR}/libdxvk_${lib}.so.0" && ! -e "${GAME_DIR}/libdxvk_${lib}.so" ]]; then
        ln -sf "libdxvk_${lib}.so.0" "${GAME_DIR}/libdxvk_${lib}.so"
    fi
done

# SDL3 / SDL3_image
cp -a "${BUILD_DIR}"/_deps/sdl3-build/libSDL3.so* "${GAME_DIR}/"
if compgen -G "${BUILD_DIR}/_deps/sdl3_image-build/libSDL3_image.so*" > /dev/null; then
    cp -a "${BUILD_DIR}"/_deps/sdl3_image-build/libSDL3_image.so* "${GAME_DIR}/"
fi

# GameSpy (optional)
[[ -f "${BUILD_DIR}/libgamespy.so" ]] && cp -f "${BUILD_DIR}/libgamespy.so" "${GAME_DIR}/"

if ! compgen -G "${GAME_DIR}/*.big" > /dev/null; then
    echo "WARNING: No .big assets found in ${GAME_DIR} — the game will likely fail to start."
fi

echo "==> Launching GeneralsXZH from ${GAME_DIR}"
cd "${GAME_DIR}"
export LD_LIBRARY_PATH="${GAME_DIR}:${LD_LIBRARY_PATH:-}"
export DXVK_WSI_DRIVER="SDL3"
export DXVK_LOG_LEVEL="${DXVK_LOG_LEVEL:-info}"
export DXVK_HUD="${DXVK_HUD:-devinfo,fps}"

exec ./GeneralsXZH -win "$@"
