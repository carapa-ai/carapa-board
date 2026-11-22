# WhatsApp Module

## Overview

Optional WhatsApp messaging integration via carapa-wa-link. When enabled, registers a `MessagingProvider` that routes outbound messages through carapa-wa-link and starts the inbound message polling loop.

## How it works

- Imported at startup only when `ENABLE_WHATSAPP` is `true` or `1`
- On init:
  1. Calls `ensureWaLinkStack()` to ensure the carapa-wa-link Docker stack is running (via CarapaBox)
  2. Creates a `MessagingProvider` wrapping the existing `MessagingClient`
  3. Registers the provider via `setMessagingProvider()` and adds `register_group` to `project_setup`, visible and callable only by main orchestration agents
  4. Initializes the messaging connection (non-blocking — app works without it)
  5. On successful connection: starts the message polling loop (run recovery belongs to core startup)
- Integration pattern: **provider registry** — registers into `src/modules/messaging/registry.ts`
- Exposes `enableWhatsApp: true` config flag so the UI shows WhatsApp controls

## Files

| File                  | Purpose                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `index.ts`            | `CarapaModule` implementation — creates WhatsApp provider, wires init chain |
| `config.ts`           | Reads `ENABLE_WHATSAPP`, `MCP_WHATSAPP_STACK`                               |
| `stack.ts`            | Ensures the WhatsApp stack is running through CarapaBox                     |
| `messaging-client.ts` | WhatsApp transport client                                                   |
| `whatsapp-router.ts`  | Inbound message polling and processing                                      |
| `whatsapp-routes.ts`  | Optional group/link/logout HTTP routes                                      |
| `tools.ts`            | WhatsApp group registration tool                                            |

Shared message types and outbound dispatch live in `src/modules/messaging/`. Bridge and kanban delivery work independently of this module. The standalone Direct MCP entrypoint registers outbound messaging and tools when enabled, without starting a second inbound poller.

## Environment variables

| Variable               | Default                     | Description                                                                                                                                 |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_WHATSAPP`      | `false`                     | Set to `true` to enable the module                                                                                                          |
| `MCP_WHATSAPP_URL`     | `http://localhost:3467/mcp` | carapa-wa-link MCP endpoint URL                                                                                                             |
| `MCP_WHATSAPP_STACK`   | `carapa-wa-link`            | Docker stack name for the WhatsApp service                                                                                                  |
| `CARAPA_WA_LINK_TOKEN` | _(none)_                    | Auth token for carapa-wa-link media downloads. Read from `$SECRETS_DIR/carapa_wa_link_token` or env var. Must match carapa-wa-link's config |

## Prerequisites

- A running [carapa-wa-link](https://github.com/carapa-ai/carapa-wa-link) instance (coming soon: the repository is not public yet)
- A running CarapaBox instance (to manage the wa-link Docker stack)
- Token must match between board and wa-link

## Enabling

1. Add to `.env`:

   ```bash
   ENABLE_WHATSAPP=true
   # Host mode only — Docker mode uses the compose override automatically
   MCP_WHATSAPP_URL=http://localhost:3467/mcp
   ```

2. Generate and set the WhatsApp token (must match carapa-wa-link's config):

   ```bash
   openssl rand -hex 30 > ~/.carapa/secrets/board/carapa_wa_link_token
   ```

3. Restart carapa-board. The sidebar will show a WhatsApp status panel and a "Connect WhatsApp group" button.

## Disabling

Set `ENABLE_WHATSAPP=false` or leave it unset. The module is not imported, the UI hides WhatsApp controls, and WhatsApp tools are not advertised. The source directory may be omitted in this mode. Status reports disconnected, chat discovery returns an empty list, and external sends are logged and skipped without contacting wa-link. Bridge and kanban messages still deliver normally.
