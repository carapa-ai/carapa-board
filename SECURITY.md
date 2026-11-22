# Security Policy

## Reporting a vulnerability

E-mail **hello@carapa.ai** with the subject prefix `[SECURITY]`. Do not open a public GitHub issue for a vulnerability. GitHub private vulnerability reporting on this repository is also accepted.

## Supported versions

CarapaBoard is in alpha. During the alpha only the latest 0.x release receives security fixes.

## Security model

Agents run inside Docker containers managed by CarapaBox, the only component that talks to Docker; they have no Docker socket, and git credentials stay outside the sandbox. Model-provider credentials stay outside it only when api-relay credential injection is configured; the setup skill also offers authenticating the agent CLIs inside the sandbox (or copying credentials there), in which case agents can read them. CarapaBoard enforces per-user project access and signed requests from approved devices. The threat model, trust boundaries and the mitigations are described in [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- Agent harnesses run with broad permissions inside their sandbox. CarapaBox (container hardening, egress proxy, credential relay) is the isolation boundary, not the harness.
- CarapaBoard keeps user data, agent transcripts and long-term memory in PostgreSQL and on disk without encryption at rest (only stored tokens are encrypted, with `CARAPA_BOARD_ENCRYPTION_KEY`). Protect the host and its backups.
- The default `docker-compose.yml` publishes the Board port and the PostgreSQL port on `127.0.0.1` only. `CARAPA_BOARD_BIND` and `CARAPA_BOARD_DB_BIND` change the bind address; setting `0.0.0.0` exposes the port on every host interface, so put the Board behind the ingress/TLS setup or a firewall first (see [Network access](README.md#network-access)).
