# Board → Brain through CarapaBox ingress

Board discovers Brain endpoints from CarapaBox's `sandbox_ps` ingress entries.
Docker's published LAN ports can hide Board's source address behind a shared
gateway. Ingress then rejects the connection with `ECONNRESET`, even though
endpoint discovery succeeded.

For a Board container on the same host as CarapaBox, use a dedicated address on
the existing ingress edge network:

1. Reserve an unused address in that network for Board. With the default subnet,
   ingress uses `172.29.255.2`, nginx commonly uses `.3`, and Board can use `.4`.
2. Add only Board's address (`172.29.255.4/32` in this example) to CarapaBox's
   `INGRESS_HTTP_ALLOW_CIDRS`, preserving existing approved clients. Recreate
   only the controller to load the changed environment.
3. Set Board's `.env`:

   ```dotenv
   COMPOSE_FILE=docker-compose.yml:docker-compose.ingress.yml
   BRAIN_INGRESS_HOST=172.29.255.2
   BOARD_INGRESS_IP=172.29.255.4
   BOARD_INGRESS_NETWORK=carapa_ingress_edge
   ```

   Preserve any existing Compose override files in `COMPOSE_FILE`.

4. Validate with `docker compose config --quiet`, build Board, and recreate only
   `carapa-board`. Check Brain's unauthenticated `/version` from inside Board,
   then confirm retained objective events are acknowledged and leave the outbox.

`BRAIN_INGRESS_HOST` overrides only the host of ingress endpoints. Reserved ports
still come from CarapaBox, multiple HTTP endpoints are identified through
Brain's `/version`.
Leave the override unset when the advertised ingress host is directly reachable.

Do not allow a shared NAT gateway or an entire sandbox subnet, and do not attach
agent sandboxes or Board's browser sidecar to the ingress edge network. See
[CarapaBox ingress](../../carapa-box/docs/ingress.md) for the source restrictions.
