#!/usr/bin/env sh
# Containerized dev runner — no host node, npm, or deno needed.
#
#   scripts/dev.sh install                    # deno install --frozen into the named volume
#   scripts/dev.sh add npm:zod@4.0.0          # deno add, updating package.json + deno.lock
#   scripts/dev.sh deno task build            # tsc -> dist/
#   scripts/dev.sh deno task test
#   scripts/dev.sh node dist/index.js         # run the built server
#
# Deno is the package manager/task runner; the tools it installs execute under
# the node runtime baked into the image. node_modules lives in the named volume
# sheetrender-mcp-node-modules, never in the host tree.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="sheetrender-mcp-dev"
VOLUME="sheetrender-mcp-node-modules"
DENO_VOLUME="sheetrender-mcp-deno-dir"

docker build -q -t "$IMAGE" -f "$REPO_ROOT/Dockerfile.dev" "$REPO_ROOT" >/dev/null

docker_run() {
  docker run --rm --init --network=host \
    -v "$REPO_ROOT":/repo \
    -v "$VOLUME":/repo/node_modules \
    -v "$DENO_VOLUME":/deno-dir \
    -e DENO_DIR=/deno-dir \
    -w /repo \
    -e SHEETRENDER_API_KEY="${SHEETRENDER_API_KEY:-}" \
    -e SHEETRENDER_API_URL="${SHEETRENDER_API_URL:-}" \
    "$IMAGE" "$@"
}

case "${1:-}" in
  install)
    shift
    docker_run deno install --frozen "$@"
    ;;
  add)
    shift
    docker_run deno add "$@"
    ;;
  deno|node)
    docker_run "$@"
    ;;
  *)
    echo "usage: scripts/dev.sh install | add <spec> | deno <args> | node <args>" >&2
    exit 2
    ;;
esac
