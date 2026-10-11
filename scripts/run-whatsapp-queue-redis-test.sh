#!/usr/bin/env bash
# Runs the Redis-backed WhatsApp queue telemetry test against disposable Docker Redis.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the disposable Redis test.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker is not running. Start Docker Desktop and try again.' >&2
  exit 1
fi

image="${MODA_TEST_REDIS_IMAGE:-redis:7.4-alpine}"
container_id=''
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The Docker-assigned port and loopback binding avoid collisions with local Redis.
container_id="$(docker run --detach --rm \
  --name "moda-messaging-redis-test-$$-$RANDOM" \
  --publish '127.0.0.1::6379' \
  --memory 128m \
  "$image" redis-server --save '' --appendonly no)"

mapping="$(docker port "$container_id" 6379/tcp)"
if [[ "$mapping" != 127.0.0.1:* ]]; then
  echo "Refusing unexpected Redis port mapping: $mapping" >&2
  exit 1
fi
port="${mapping##*:}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo 'Could not resolve the disposable Redis host port.' >&2
  exit 1
fi

ready=false
for (( attempt=0; attempt<60; attempt++ )); do
  if [[ "$(docker exec "$container_id" redis-cli ping 2>/dev/null || true)" == PONG ]]; then
    ready=true
    break
  fi
  sleep 0.25
done
if [[ "$ready" != true ]]; then
  echo 'Disposable Redis did not become ready.' >&2
  docker logs --tail 20 "$container_id" >&2 || true
  exit 1
fi

# The test reads TEST_REDIS_URL; the producer's Redis adapter reads REDIS_URL.
# Override both for this one process, regardless of the user's normal Redis URL.
redis_url="redis://127.0.0.1:$port"
if [[ $# -eq 0 ]]; then
  set -- tests/whatsapp-queue-telemetry.test.mjs
fi
printf 'Running Redis-backed WhatsApp tests on disposable Redis (localhost:%s).\n' "$port"
NODE_ENV=test \
  TEST_REDIS_URL="$redis_url" REDIS_URL="$redis_url" \
  node --import tsx --test "$@"
