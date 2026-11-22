# Pair a CarapaBoard integration

Run with Bun from this repository. Pairing is supported for CLI/scripts; browser
and Android sign-in remain unchanged.

```sh
bun scripts/carapa-device.ts --url https://your-board.example \
  --name 'Linkwarden importer' --scopes knowledge:read,knowledge:write \
  --credentials-file ~/.config/carapa-board/linkwarden.json
```

The client generates a P-256 key locally, displays an eight-character code and
waits. On an **already approved admin device**, open **Devices → Pair device**,
enter the code, select the owner, review/reduce scopes and approve. Codes expire
after ten minutes. A lost response can be retried by rerunning the command with
the same credential file; an already approved key is recovered even after the code
expires. Choose **Use another code** on the Devices review to enter a replacement
code. An expired unapproved request can be restarted; a denied request needs a new credential file.

Only the public key reaches Board. Credential files use mode `0600` and are bound
to one Board origin. Never commit or share them. Remote connections require
HTTPS and redirects are rejected. A server token or password is not required.

Run `--list-scopes` for the catalog. Explicit mappings in
`src/lib/device-auth/policy.ts` document the supported HTTP operations. Unmapped
operations are denied, even when a client is owned by an administrator. New APIs
must be explicitly reviewed and mapped before integrations can use them.

- `read` permits the domain's listed read/search operations.
- `write` permits creating/updating data; it does not grant deletion or sharing.
- `delete`, `execute`, `send`, `control`, and `push` are separate permissions.
- Operations with effects across categories require every applicable scope.
  Task creation can enter executable project stages and requires task execution;
  schedule and dataset writes also require execution because they can start work.
- Execution runs the configured agents with their normal tools and capabilities.
- Scopes never replace current owner/project/conversation/KB access checks.
- Security/account administration, credential management, sharing, MCP,
  interactive browser/terminal bridges, and WebSocket/ticket APIs are unavailable.

Integrations default to 30 days. Admins can choose 1, 7, 30, 90 days or explicitly
choose no expiry; reduce scopes, renew expiry, or revoke the device. Scope
increases require a new pairing. Ordinary users may revoke integrations they own
but cannot expand or renew access. Expiry and revocation apply to token renewal
and every request, including already-issued sessions. They do not undo jobs that
were legitimately started earlier. Integrations do not count as interactive
login devices for last-device protection.

Use the shared client without importing Board server configuration:

```ts
import { CarapaDeviceClient } from '../src/lib/carapa-device-client.js';
const client = CarapaDeviceClient.load(boardUrl, credentialFile);
const kbs = await (await client.request('/api/knowledge')).json();
```

`request(path, method, body)` signs JSON requests (and supports FormData), obtains
short-lived sessions and renews them before expiry. It does not retry mutations:
callers such as the Linkwarden importer must reconcile uncertain writes.
