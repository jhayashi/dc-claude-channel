# chatmail-docker — local relay fixture

Local [`chatmail/docker`](https://github.com/chatmail/docker) relay for
tier-2 integration tests. Runs on loopback only; never exposes mail
services to the LAN.

## Quick start (Podman)

```bash
cd plugin/test/integration/chatmail-docker
./podman-run.sh up    # pull + start + wait for /new readiness
```

Stop (keep account state):
```bash
./podman-run.sh down
```

Wipe all account state and start fresh:
```bash
./podman-run.sh down
podman volume rm chatmail-docker_relay-data
./podman-run.sh up
```

## Quick start (Docker)

```bash
cd plugin/test/integration/chatmail-docker
docker compose up -d
```

Stop (keep account state):
```bash
docker compose down
```

Wipe all account state:
```bash
docker compose down -v
```

## Port mapping

| Service | Host port | Container port |
|---------|-----------|----------------|
| HTTPS (`POST /new` account API) | 127.0.0.1:**8443** | 443 |
| SMTPS submission | 127.0.0.1:**10465** | 465 |
| IMAPS | 127.0.0.1:**10993** | 993 |

Override via env vars: `RELAY_HTTPS_PORT`, `RELAY_SMTPS_PORT`, `RELAY_IMAPS_PORT`
(see `.env.example`).

## Mail domain

The relay runs on `_chatmail.test` (chatmail's test-domain mode). The
leading underscore tells chatmail to issue a self-signed TLS cert — no
Let's Encrypt or real domain registration needed. DC core connects over
TLS with `accept_invalid_certificates` set by the test harness
(`dc-client.ts`, `client-sim.ts`).

## Why Podman needs a wrapper script

`podman-compose` doesn't propagate Podman's `--systemd=always` flag.
The `chatmail/docker` image uses systemd as PID 1 and exits immediately
without that flag. `./podman-run.sh` is a thin wrapper around
`podman run --systemd=always` that provides the same lifecycle commands
(`up`, `down`, `logs`).

## Image

```
ghcr.io/chatmail/docker@sha256:11aa3f9de095e69e3380257a49f2f9d99827e9fb9a1843817a5fab4dacb683ac
```

Digest pinned 2026-04-27. Update by pulling `ghcr.io/chatmail/docker:main`,
running `./podman-run.sh up` to verify all three ports work, then
updating both `docker-compose.yml` and `podman-run.sh` with the new
digest.

## Env overrides

Copy `.env.example` to `.env` in this directory to override ports or the
mail domain (Docker Compose reads `.env` automatically; `podman-run.sh`
reads it via `export $(cat .env | xargs)`).
