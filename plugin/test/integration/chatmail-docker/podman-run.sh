#!/usr/bin/env bash
# Podman wrapper for the chatmail relay test fixture.
#
# podman-compose does not propagate --systemd=always, so the container
# exits immediately (the image uses systemd as PID 1). Use this script
# instead of podman-compose when running with Podman.
#
# Usage:
#   ./podman-run.sh up    # start detached (default if no arg)
#   ./podman-run.sh down  # stop and remove
#   ./podman-run.sh logs  # tail logs
#
# Env overrides (same as docker-compose .env.example):
#   MAIL_DOMAIN      default: _chatmail.test
#   RELAY_HTTPS_PORT default: 8443
#   RELAY_SMTPS_PORT default: 10465
#   RELAY_IMAPS_PORT default: 10993

set -euo pipefail

IMAGE="ghcr.io/chatmail/docker@sha256:11aa3f9de095e69e3380257a49f2f9d99827e9fb9a1843817a5fab4dacb683ac"
NAME="chatmail-docker_relay_1"
VOLUME="chatmail-docker_relay-data"

MAIL_DOMAIN="${MAIL_DOMAIN:-_chatmail.test}"
RELAY_HTTPS_PORT="${RELAY_HTTPS_PORT:-8443}"
RELAY_SMTPS_PORT="${RELAY_SMTPS_PORT:-10465}"
RELAY_IMAPS_PORT="${RELAY_IMAPS_PORT:-10993}"

cmd="${1:-up}"

case "$cmd" in
  up)
    echo "Starting chatmail relay ($NAME) …"
    podman run -d \
      --systemd=always \
      --name "$NAME" \
      --replace \
      -e "MAIL_DOMAIN=$MAIL_DOMAIN" \
      -p "127.0.0.1:${RELAY_HTTPS_PORT}:443" \
      -p "127.0.0.1:${RELAY_SMTPS_PORT}:465" \
      -p "127.0.0.1:${RELAY_IMAPS_PORT}:993" \
      -v "${VOLUME}:/var/lib/chatmail" \
      --restart unless-stopped \
      "$IMAGE"
    echo "Relay started. Waiting for /new endpoint…"
    until curl -sk "https://127.0.0.1:${RELAY_HTTPS_PORT}/new" | grep -q email 2>/dev/null; do
      sleep 2
    done
    echo "Relay ready at https://127.0.0.1:${RELAY_HTTPS_PORT}"
    ;;
  down)
    echo "Stopping chatmail relay …"
    podman rm -f "$NAME" || true
    ;;
  logs)
    podman logs -f "$NAME"
    ;;
  *)
    echo "Usage: $0 [up|down|logs]" >&2
    exit 1
    ;;
esac
