#!/usr/bin/env bash
# Deploys the HT Global website on the VM. Idempotent.
#   /home/ubuntu/ht-global/repo/deploy/deploy.sh
#
# Rollback: this script tags the image that was running as ht-global-web:previous.
#   docker tag ht-global-web:previous ht-global-web:latest
#   docker compose -f /home/ubuntu/ht-global/repo/deploy/docker-compose.yml up -d --no-build
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/ht-global/repo}"
COMPOSE=(docker compose -f "$REPO_DIR/deploy/docker-compose.yml")
IMAGE=ht-global-web
CONTAINER=ht-global-web
WAIT_SECONDS=60

cd "$REPO_DIR"
git fetch --prune origin main
git reset --hard origin/main

# Keep the running image as :previous for rollback.
if prev_id=$(docker image inspect --format '{{.Id}}' "$IMAGE:latest" 2>/dev/null); then
  docker tag "$prev_id" "$IMAGE:previous"
fi

"${COMPOSE[@]}" up -d --build

echo "Waiting up to ${WAIT_SECONDS}s for $CONTAINER to be healthy..."
status=unknown
for ((i = 0; i < WAIT_SECONDS; i += 2)); do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 2
done

if [ "$status" != healthy ]; then
  echo "DEPLOY FAILED: $CONTAINER status is '$status'. Last 20 log lines:" >&2
  docker logs --tail 20 "$CONTAINER" >&2 || true
  cat >&2 <<MSG

Roll back to the previous image:
  docker tag $IMAGE:previous $IMAGE:latest
  docker compose -f $REPO_DIR/deploy/docker-compose.yml up -d --no-build
MSG
  exit 1
fi

echo "Healthy. Last 20 log lines:"
docker logs --tail 20 "$CONTAINER"
# Dangling images only (the disk is tight); the tagged :previous image is kept.
docker image prune -f
echo "Deploy OK: $(git rev-parse --short HEAD)"
