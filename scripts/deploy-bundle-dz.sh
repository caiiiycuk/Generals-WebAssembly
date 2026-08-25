#!/usr/bin/env bash
# Build, protect and publish the GeneralsX web bundle.
#
# Usage:
#   scripts/deploy-bundle-dz.sh <version>
#
# Environment:
#   DEPLOY_SLUG=generalsx              Object prefix on dos.zone and br-bundles
#   HECTOR_ROOT=/path/to/hector/protect
#   HECTOR_KEY=/path/to/server.key
#   HECTOR_WS_URL=wss://hector.dos.zone/ws
#
# Heavy .wasm/.data files are Brotli-compressed and uploaded to br-bundles;
# the HTML shell, JavaScript and configuration are published to doszone-uploads.
#
# GeneralsX @build caiiiycuk 21/08/2026 Adapt Dos.Zone bundle deployment.
set -euo pipefail

VERSION="${1:?usage: $0 <version>}"
case "$VERSION" in
    *[!A-Za-z0-9._-]*|'') echo "ERROR: version may contain only A-Z, a-z, 0-9, ., _ and -" >&2; exit 1 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/web/dist"
DEPLOY_SLUG="${DEPLOY_SLUG:-generalsx}"
case "$DEPLOY_SLUG" in
    *[!A-Za-z0-9._-]*|'') echo "ERROR: DEPLOY_SLUG contains unsupported characters" >&2; exit 1 ;;
esac

SITE_PREFIX="https://dos.zone/$DEPLOY_SLUG/v$VERSION"
BINARY_PREFIX="https://br.cdn.dos.zone/$DEPLOY_SLUG/v$VERSION"
BINARY_STAGE="$(mktemp -d)"

cleanup() {
    rm -rf "$BINARY_STAGE"
}
trap cleanup EXIT

cd "$REPO_ROOT"

echo "==> Configuring optimized web release"
cmake --preset emscripten
echo "==> Building web engines"
cmake --build build/emscripten --target z_generals g_generals
echo "==> Assembling web bundle"
scripts/web/make-dist.sh --skip-assets

# The loader reads this before game.js, so engine preloading goes directly to
# the Brotli objects while all small shell files remain on doszone-uploads.
printf 'window.GX_ENGINE_URLS = {"GeneralsXZH":"%s/GeneralsXZH.wasm","GeneralsX":"%s/GeneralsX.wasm"};\n' \
    "$BINARY_PREFIX" "$BINARY_PREFIX" > "$DIST_DIR/deployment-config.js"
perl -0pi -e 's|<script src="game\.js"></script>|<script src="deployment-config.js"></script>\n<script src="game.js"></script>|' \
    "$DIST_DIR/index.html"

# Hector is intentionally disabled for the pthread + wasm-exception web build:
# the current injector supports neither feature. Keep this invocation here for
# the future compatible injector; enabling it is deliberately an explicit edit.
# echo "==> Applying Hector protection"
# scripts/web/apply-hector-protection.sh "$DIST_DIR"

echo "==> Compressing heavy bundle files"
while IFS= read -r -d '' file; do
    relative="${file#$DIST_DIR/}"
    staged="$BINARY_STAGE/$relative"
    install -d "$(dirname "$staged")"
    brotli --force --best --output="$staged" "$file"

done < <(find "$DIST_DIR" -type f \( -name '*.wasm' -o -name '*.data' \) -print0)

echo "==> Publishing Brotli payloads"
rclone copy "$BINARY_STAGE" "br-bundles:68bbc47d0de7-br-bundles/$DEPLOY_SLUG/v$VERSION" \
    --s3-acl public-read \
    --metadata-set content-encoding=br \
    --size-only \
    --transfers 32 \
    --checkers 32 \
    --fast-list \
    --stats 30s \
    --stats-one-line \
    --stats-log-level NOTICE

echo "==> Publishing shell"
rclone copy "$DIST_DIR" "sec-dos-zone:68bbc47d0de7-sec-dos-zone/$DEPLOY_SLUG/v$VERSION" \
    --s3-acl public-read \
    --exclude '*.wasm' \
    --exclude '*.data' \
    --size-only \
    --transfers 32 \
    --checkers 32 \
    --fast-list \
    --stats 30s \
    --stats-one-line \
    --stats-log-level NOTICE

echo "deployment: $SITE_PREFIX/"
