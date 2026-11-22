/** Agent-facing `/auth.md` guide (WorkOS auth.md convention). The PRM stays authoritative. */
export function renderAuthGuide(origin: string): string {
  return `# CarapaBoard MCP authentication

This server exposes MCP tools at \`${origin}/mcp/carapa-board\`.
Access uses OAuth 2.1: a human approves your client in the browser, then you use a bearer token.
No token has to be copied by hand. Discovery documents are authoritative; this page is a summary.

## Discovery

- Protected resource metadata (RFC 9728): \`${origin}/.well-known/oauth-protected-resource/mcp/carapa-board\`
- Authorization server metadata (RFC 8414): \`${origin}/.well-known/oauth-authorization-server\`
- An unauthenticated MCP request returns \`401\` with
  \`WWW-Authenticate: Bearer resource_metadata="<protected resource metadata URL>"\`.

## Flow

1. **Register** (RFC 7591): \`POST ${origin}/oauth/register\` with JSON
   \`{"client_name": "...", "redirect_uris": ["http://127.0.0.1:PORT/callback"], "token_endpoint_auth_method": "none"}\`.
   Only public clients are supported. Redirect URIs must be \`https://\` or loopback
   (\`http://127.0.0.1:*\`, \`http://localhost:*\`). The response contains \`client_id\`.
2. **Authorize**: open \`${origin}/oauth/authorize\` in the user's browser with
   \`response_type=code\`, \`client_id\`, \`redirect_uri\`, \`state\`, \`code_challenge\`,
   \`code_challenge_method=S256\` (PKCE is required) and
   \`resource=${origin}/mcp/carapa-board\` (RFC 8707).
3. **User approves**: the user signs in, picks the target and access, and confirms with a
   device signature. The browser is then redirected to \`redirect_uri?code=...&state=...\`.
   Codes are single use and expire after 60 seconds.
4. **Token**: \`POST ${origin}/oauth/token\` (form or JSON) with \`grant_type=authorization_code\`,
   \`client_id\`, \`code\`, \`redirect_uri\`, \`code_verifier\` and \`resource\`. The response is
   \`{access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope}\`.
5. **Call MCP**: send \`Authorization: Bearer <access_token>\` to the resource URL.
6. **Refresh**: \`POST ${origin}/oauth/token\` with \`grant_type=refresh_token\`, \`client_id\` and
   \`refresh_token\`. Refresh tokens rotate: use the newest one only. Replaying an already used
   refresh token revokes the whole grant. Refresh never extends the approved duration.

## What the user grants

- **Projects**: an explicit list of the projects the user picks, each with its own access level. A parent project does not bring its children; each one must be listed. The user's personal main project, when listed, also covers the projects the user can reach. The user can change the list, the per-project access and the expiry later; a project the user loses access to drops out of the grant.
- **Access**: per project, \`read\` or \`write\`; the token scope is \`mcp:read mcp:write\` when any project is
  \`write\`, otherwise \`mcp:read\`. \`write\` carries the same per-project tool permissions as a CarapaBoard agent for that project; \`read\` can only call
  read tools. Knowledge-base tools take an optional \`target_project\` (any listed project) and respect the user's
  own knowledge-base role: a viewer is read-only and a knowledge base the user is not a member of is not visible.
- **Duration**: 1, 7, 30 or 90 days. Administrator access is never granted.
- Tokens work only on the MCP endpoints above for the origin named in \`resource\`; they are
  rejected on the REST API and on \`/mcp/carapa-orchestrator\`.

## Errors

| Endpoint | Error | Meaning |
| --- | --- | --- |
| register | \`invalid_redirect_uri\` | Redirect URI is not https or loopback http |
| register | \`invalid_client_metadata\` | Not a public client, or unsupported grant/response type |
| authorize | \`invalid_request\` | Unknown client, redirect URI mismatch, or missing PKCE S256 |
| authorize | \`invalid_target\` | \`resource\` is not an MCP endpoint on this origin |
| authorize | \`access_denied\` | The user denied the request |
| token | \`invalid_request\` | Missing parameter |
| token | \`invalid_client\` | Unknown \`client_id\` |
| token | \`invalid_grant\` | Bad, expired or reused code or refresh token; wrong PKCE verifier; grant revoked or expired |
| token | \`invalid_target\` | \`resource\` differs from the one authorized |
| token | \`unsupported_grant_type\` | Only \`authorization_code\` and \`refresh_token\` |
| MCP | \`401\` | Missing, expired or revoked token: refresh, or restart the flow |

## Revocation

\`POST ${origin}/oauth/revoke\` (RFC 7009) with \`token=<access or refresh token>\`. A refresh token
revokes the whole grant; an access token revokes only itself. Users can also revoke grants in the
CarapaBoard UI. A revoked, expired or disabled-owner grant gets \`401\` immediately.
`;
}
