# Project mail client

Email-enabled projects have a Mail tab in the shared Chat/Kanban right pane and
in the objective workspace pane. Enable CarapaMail and configure the project's
token in project settings. The browser communicates with Board; Board uses that
project's token to reach the configured `CARAPA_MAIL_MCP_URL`. No mailbox
credentials are sent to the browser.

Explicit project viewers can browse folders, search, read filtered plain-text
messages, and download attachments. Editors and owners can also compose/reply,
mark read/unread, and move selected messages when the account permits those
operations. Administrators follow the existing project administration boundary;
other users' personal main projects remain private. Chat-only participants have
no mailbox access. These permissions are enforced by the API as well as the UI.

Reply uses Reply-To (falling back to From), quotes the message, and supplies
In-Reply-To/References when valid message IDs are available. Opening a message
marks it read for editors/owners only. Move to Trash uses the IMAP special-use
folder; accounts without that metadata prompt for an existing destination.
There is no permanent-delete operation in this client.

Drafts and navigation remain in memory per signed-in user, project, and account
across pane/route switches. Reloading the app discards them; signing out clears
them. Failed sends retain their draft. Sends and mailbox mutations are never
automatically retried; after an interrupted send, check delivery before manually
trying again. Sent-folder copies depend on the provider's existing behavior.

## Agent access over MCP

In a parent-shared sandbox, the relay token comes from the sandbox owner; child mail settings remain stored separately.

Agents running for a mail-enabled, non-main project (objective, kanban and
Claude/Codex/pi chat runs) get these tools from the board MCP server:
`carapamail_list_folders`, `carapamail_list_emails`, `carapamail_read_email`,
`carapamail_search`, `carapamail_download_attachment` and, once CarapaMail offers
it, `carapamail_save_draft`. They always act on the run token's own project's
mailbox; `project_id` is not a parameter and a call naming one is rejected.
Send, move, delete, mark-read, list-accounts and stats stay DirectLLM-only, and
the main agent, mail-disabled projects, human and OAuth tokens get no mail tools
over MCP. CarapaMail still enforces the account's own permissions per token. The
tool list is discovered from CarapaMail when the MCP session starts (5 s limit);
if it is unreachable the session starts without mail tools and a later session
retries. Use a dedicated mail project for agents that process mail.

## API and rollout

All `/api/projects/:pid/mail` endpoints require an authenticated Board user and
the normal device request signature. Reads use `GET accounts`, `folders`,
`messages` (optional `query` and `page`), `messages/:uid`, and `attachment`.
Account IDs are explicit; folder defaults to INBOX. Mutations use `POST send`,
`read-state` (`uids`, `seen`), and `move` (`uids`, `destination`). Responses use
camelCase. Attachments pass through CarapaMail's security gate, then Board's
same-origin download proxy with a 25 MB streaming limit and no redirects.

Deploy the CarapaMail changes before the Board changes. CarapaMail adds
`carapamail_mark_read`, folder `specialUse`, reply metadata on message reads, and
optional validated `inReplyTo`/`references` on `carapamail_send`. Existing tools
and callers remain compatible. No database migration is needed.

The first version supports one recipient, plain-text compose, and attachment
downloads. HTML composition, CC/BCC, reply-all, outgoing attachments, background
synchronization are outside this version.

Objective mode shows the same project-level Mail tab as Chat/Kanban. It is not
scoped to an objective, and the draft and navigation state are shared with
Chat/Kanban.
