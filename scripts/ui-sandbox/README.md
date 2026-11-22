# Disposable UI sandbox

Start a fresh, isolated CarapaBoard instance for UI inspection:

```bash
npm run ui:sandbox
```

The launcher seeds five named projects, starts the backend and Vite on free
loopback ports, signs a real admin browser session in through the normal login
flow, and opens it with `playwright-cli`. Press Ctrl+C to stop every child
process and delete the temporary database and group files.

For agents, `ui:sandbox` is a long-running server, not a terminating check.
Launch it in a persistent terminal session with a short initial yield. Wait
only until `Disposable CarapaBoard UI sandbox is ready.`, then run browser
commands through separate tool calls while the launcher stays running. Do not
keep polling for process completion. After verification, send Ctrl+C to your
own launcher's terminal and confirm cleanup completes; leave a reused Board
hook-owned preview running. A harness with no persistent terminal can set
`UI_SANDBOX_PID_FILE=<path>`: the launcher then records the pid (= process-group
id) of its `start.ts` process there, and `kill -INT -- "-$(cat <path>)"` stops it.

The launcher prints the browser command after startup. In an unmanaged
run, use the printed `playwright-cli -s=<unique-session> <command>` form for
screenshots and inspection so commands reuse the authenticated browser and
its approved device key. Browser evidence is still written under the
disposable sandbox root. The smoke check exercises this cross-process session
reuse and fails if the device key or approval state is lost.

During recorded Testing, CarapaBoard injects the exact run-scoped
`PLAYWRIGHT_CLI_SESSION`, daemon/socket directories, and recording directory.
The launcher prints `playwright-cli <command>` without `-s`; use that bare
command so the browser remains owned by CarapaBoard. The launcher does not
close this board-owned browser or start/stop recording; CarapaBoard performs
the exact-run recording finalization after Testing completes. Other managed
runs also preserve Board's injected session and use bare commands. The named
two-user sessions below describe an unmanaged launcher; tabs in a shared Board
browser use the same cookies and cannot isolate two user identities.

The security scenario (`npm run ui:sandbox:security`) is fetch-only and does not
need `playwright-cli`.

Board's **Start browser** control invokes `.agent/start-browser.sh` for a
checkout without a `.preview-url`. That hook runs this same launcher, preserves
the Board-managed Playwright session, and publishes the ready URL through
`CARAPA_BROWSER_URL_FILE`. No nginx or exposed app port is needed. Close/Restart
in the outer Board Browser pane owns this launcher and its disposable services.
In a managed agent run, use the printed bare `playwright-cli` command to keep
the browser visible in the shared viewer.

If the user already started that preview, inspect it with
`playwright-cli tab-list` and `playwright-cli snapshot` before launching another instance.
The hook-owned app survives viewer disconnect and conversation completion;
stop only your own test launcher during verification cleanup.

Options:

```bash
npm run ui:sandbox -- --no-browser  # services and fixtures only
npm run ui:sandbox -- --keep        # preserve the printed temporary root
npm run ui:sandbox:smoke            # authenticated browser smoke check
npm run ui:sandbox:manual-overflow # full-cap manual task run + stop lifecycle
npm run ui:sandbox:security         # file-serving headers/containment (/uploads, /artifacts, public shares), MCP reach checks (logged-in users get their main's scope, never '*'), symlinked artifacts-root and group-folder (objective, dashboard, project file) refusals, and chat attachment-path checks (only this project's uploads reach the model)
npm run ui:sandbox:two-user         # approved admin + project-member browsers
UI_SANDBOX_CHAT_EVAL=1 npm run ui:sandbox  # opt-in chat rendering fixtures (below)
UI_SANDBOX_TASK_DETAIL_EVAL=1 npm run ui:sandbox  # opt-in task details fixtures (below)
UI_SANDBOX_NOTIFICATIONS_EVAL=1 npm run ui:sandbox  # opt-in notification fixtures (below)
```

Two-user mode seeds both identities before domain fixtures are created. Device
approval mutations require a fresh device signature, so the launcher needs a
browser (`playwright-cli`; `--no-browser` is rejected). The sandbox backend
approves only the admin's very first pending `ui-admin` device in its disposable
database (a pending device cannot sign its own approval); the launcher then
approves the pending `ui-member` device by clicking Approve on the admin
Devices page in the signed-in admin browser, and verifies it through the device
list. The fixture set includes
a completed task owned by `ui-member` and triggered by `ui-admin`, plus a
member-only actionable form that appends its response to that task transcript.
In a Board-managed browser the `playwright-cli` shim pins every command to one
shared session, so the launcher runs the member session with the real CLI
(`CARAPA_PLAYWRIGHT_REAL`) as an independent, launcher-owned browser with its own
daemon directories under the sandbox root; drive it with that binary and
`-s=<printed member session>`, not the shim.
No agent, Firebase service, or production authentication bypass is required.

Both users initially reach the real pending-device gate. After approving and
verifying each device, the launcher leaves both sessions available for
cross-user checks:

```bash
playwright-cli -s=<printed-session> <command>         # ui-admin
playwright-cli -s=<printed-member-session> <command>  # ui-member
```

The password-only bootstrap session is never loaded into either browser and is
used only with the existing admin device API.

The fixture projects cover running, paused, and stopped kanban boards, chat and
artifacts, objective states, and a disposable `ui-running` Git repository with
an isolated task-worktree symlink plus default-checkout dirt. A loopback-only,
OpenAI Responses-compatible simulator is configured as the default chat and
kanban model. It holds streams until its local control endpoint releases,
fails, or aborts them, enabling deterministic running/stop/concurrency checks
without external credentials or network access. The local CarapaBox stub
executes only the fixture's Git reads and deterministic lifecycle operations;
real containers and external agents remain unavailable.

Default-branch integration can be checked from Changes on
`ui-task-merge-clean` and `ui-task-merge-conflict` in `ui-running`. Both are
idle review tasks with owned worktrees, one task-only commit, and one missing
local `develop` commit. The first merges cleanly; the second retains a conflict
in `tracked-dir/fixture.txt`. Merging uses the real route, Git shell command,
receipt handling, and durable next-run message. The default checkout retains
its intentional dirt. Restart the launcher for fresh histories.

`ui-ab` (paused, worktree checkout mode) has the stage alternatives `coding.b`
and `review.x`, a backlog task `ui-ab-backlog` for the Run variants selector,
and the experiment parent `ui-ab-parent` with two done variant cards
(`ui-ab-child-a`, `ui-ab-child-b`; committed branches off the fork commit, with
run, cost, and review-score history) for the comparison panel. `ui-ab` owns its
own clean default checkout (`repositories/ui-ab`), so "Merge this variant"
succeeds through the CarapaBox stub: the parent completes, and the winner badge
(`data-ui="ab-winner-badge"`), the "Winner" header (`ab-comparison-winner`) and
the disabled-after-winner state render. The stub reports the merge as done
without moving `develop`, so restart the launcher to pick a winner again.

The failing path stays walkable in `ui-ab-dirty`, which has the same experiment
(`ui-ab-dirty-parent`, `ui-ab-dirty-child-a/b`) on the shared dirty default
checkout used by `ui-running`. There the stub rejects the merge with
`[env] default checkout is dirty` (the untracked `checkout blocker.txt`), the
variant card shows "Task checkpoint pending", the panel shows the 409 error,
and the variant stays selectable for retry. The failure comes from that dirty
checkout fixture, not from a missing CarapaBox.

`/memory-review` lists a seeded `ui-sandbox` history-review batch for `ui-running` (create, supersede and forget proposals plus one skipped candidate) next to six seeded `memories` rows, including the ones the proposals target. Apply is not expected to work in the sandbox.

`ui-chat` has a pending conversation with two proposals (rule + skill); Approve writes under the sandbox data root only.

`/knowledge` lists one seeded, unindexed "UI Sandbox KB" (`welcome.md`, which carries a description and an https `sourceUrl`, plus a nested `docs/guide.md`, fake content) shared with `ui-chat` and `ui-running`, so Knowledge Hub browsing and chat message actions > Save to Knowledge Base are walkable there.

The Git allowlist fingerprints the four reviewed production default-branch
shell command forms (status, mutation, receipt recovery, cleanup), normalizing
only fixture branch names, hexadecimal commit IDs and receipt UUIDs. It does
not authorize arbitrary aliases or shell fragments. If those production scripts
change, capture and review their generated commands again, update the fingerprints
in `box-stub-response.ts`, and recheck the real browser merge workflows. Rejected
commands must not be replaced with synthetic successful API responses.

The server/web deploy lifecycle is simulated so it can be exercised end to
end: `build_service` succeeds after a short delay
(`UI_SANDBOX_BUILD_DELAY_MS`, default 5s) — or
fails when `UI_SANDBOX_BUILD_FORCE_FAIL=1` is set, which exercises the
failed-build UI (failure feedback, no enabled Restart) — and `restart_service`
asks the sandbox launcher to really re-spawn the backend process, so clients
observe a genuinely new `started_at`. Containers, agents,
git credentials, WhatsApp, email, and other external services are not tested.

## Chat, objective chat and persona / Live Mode recipe

Every chat (project chat, objective chat, persona rounds) uses the loopback
Direct-LLM simulator, and each reply stream is **held** until you release it.
A reply stuck at "Thinking…" is therefore expected, not a bug. The launcher
prints the control URL as `LLM Ctrl`; below it is `$CTRL`.

```bash
curl $CTRL/requests                                   # ids, status, lastUserText
curl -X POST $CTRL/requests/<id>/release -d '{"text":"Hello"}'  # text optional
curl -X POST $CTRL/requests/<id>/chunk   -d '{"text":"partial "}'
curl -X POST $CTRL/requests/<id>/fail    -d '{"message":"boom"}'
curl $CTRL/auto-release                               # current state
curl -X POST $CTRL/auto-release -d '{"enabled":true,"text":"Fixed reply"}'
```

Without `text`, a release replies `Simulated response to: <last user text>`.
Pick the mode by what you are checking:

- **Auto-release** (no stream-timing check): start with
  `UI_SANDBOX_LLM_AUTO_RELEASE=1 npm run ui:sandbox`, or toggle it at runtime
  with the `auto-release` call above. Each new request then completes at once
  with `text` (or the default reply) and shows as `completed` in `/requests`.
  Auto-release is off by default; turning it off restores holding for new
  requests (already completed ones are unaffected).
- **Keep holding** (running/stop/steering/concurrency checks): leave
  auto-release off, observe the running UI, then `release`, `chunk`, `fail`, or
  stop from the UI.

Where to chat:

- Project chat: `/chat/ui-chat`.
- Objective chat: `/objective/ui-objectives/ui-objective-active`.
- Persona round: project `ui-chat` > conversation `ui-conversation-pinned`
  (Mara is pre-invited) > **Participants** > **Start next round**, then release
  the held request (or enable auto-release first).
- Agent-authored messages: `ui-conversation-pinned` also holds two
  `source: 'agent'` user messages (`ui-chat-agent-same-name`, named like the
  admin, and `ui-chat-agent-ask`, `Angy (main) for ui-admin`). They render in
  another-participant bubbles with the bot icon and the
  `chat-agent-author-badge`, never as the admin's own message, and are not
  listed as participants.
- Live Mode "Work" needs no TTS (`ENABLE_TTS=false`); audio is not testable in
  this sandbox.
- The seeded Mara fixture `ui-chat-persona-long` merges with a first-round Mara
  reply (the existing grouping rule). To check a fresh persona bubble, use a
  round that follows a human message.

## Chat rendering evaluation fixtures (opt-in)

`UI_SANDBOX_CHAT_EVAL=1 npm run ui:sandbox` additionally seeds
`chat-eval-fixture.ts`. They exist for inspecting and measuring
`ChatMessageBubble` on every surface that uses it, and are off by default so the
other scenarios keep their small, stable data. Restart the launcher for a fresh
copy.

- Project chat (`ui-chat`): `ui-chat-eval`, about 50 messages (open it with
  `/chat/ui-chat?conversationId=ui-chat-eval`). It has prose, a wide table with long cells, a wide
  code line, many tool calls including a 160-line Bash output and a failed call
  (turn 9), a system note, an image and a document attachment, and a Mara
  persona turn. `ui-chat-eval-fork` is a fork of it with the fork divider.
- Task details: `ui-task-chat-eval` in `ui-running`, completed, with coding,
  testing and review runs (Chat and Run History tabs).
- Objective Runs: run `run-chat-eval-1` of `ui-objective-active` (Runs tab, open
  the run, then Transcript).
- Scheduled task: run `ui-scheduled-run-chat-eval` of `ui-scheduled-chat`
  (Runs tab).

Sending a message in `ui-chat-eval` appends to it, so restart the launcher
before comparing measurements.

## Task details evaluation fixtures (opt-in)

`UI_SANDBOX_TASK_DETAIL_EVAL=1 npm run ui:sandbox` additionally seeds
`task-detail-eval-fixture.ts` into `ui-running`. It exists for measuring the
task details dialog on every tab and viewport, and is off by default so the
other scenarios keep their small data. Restart the launcher for a fresh copy.
Open the tasks with `/board/ui-running?taskId=<id>`.

- `ui-task-detail-eval`: completed, review score 8/10 with one rejected round
  (`review_history`), eight runs across Coding, Testing and Review (including
  one error run), a Testing blocked, a Testing failed and a Testing passed
  verdict, a long transcript with tool calls, wide code, a table and artifact
  links, two dependencies, two recordings, and a merged diff of five files
  (one 112-line file, one file with a very long line).
- `ui-task-detail-eval-empty`: backlog task with no runs, changes or
  recordings, for the empty states.

The merged diff is committed on the side branch `ui-task-detail-eval` of the
`ui-running` fixture repository; the task records only its commit.

## Notification evaluation fixtures (opt-in)

`UI_SANDBOX_NOTIFICATIONS_EVAL=1 npm run ui:sandbox` additionally seeds
`notifications-eval-fixture.ts` for the admin. Off by default; restart the
launcher for a fresh copy (answering a form or dismissing consumes it).

- Bell (no task or conversation link): five Needs-you forms (a required select;
  multi-line + select + email + checkbox with `minLength`; an integer with the
  server-only rule `multipleOf: 5`; a 14-field form that scrolls; very long
  summary, title, label and options) and three text notifications (a long
  Markdown body with a chat action link, a short one without an action, a board
  link). Ages range from 4 minutes to 4 days.
- Now panel: the question task `ui-nt-question` has an attached form, the failed
  task `ui-nt-failed`, the review task `ui-nt-review` and the pinned
  conversation have attached text notifications.
- Lifecycle attention notifications (source ids `task:<task>:<run>:<event>:<admin>`,
  as the board stores them): `ui-nt-attn-question` (Question, `needs_input`) and
  `ui-nt-attn-failed` (Failed, `failed`) show a Now row; drag either to another
  stage and the row goes away without a reload and stays gone after one.
  `ui-nt-attn-late` (Backlog, `failed`) is a late delivery and is never shown;
  `ui-nt-attn-cost` (Backlog, source `cost-limit`) is the cost-limit alert and
  stays as a "Task needs your attention" row.
- Only unread notifications exist in the UI: acknowledged ones are gone from the
  bell, so there is no "read" fixture. The empty state is produced by mocking
  `/api/notifications/unread` (see the `bell-empty` view).
- Multi-select fields are not supported by the form schema (`payload-store.ts`
  accepts string, number, integer and boolean properties only).

## Mechanical UI audit (`ui:audit`)

`bun run ui:audit -- --views <views.json> [options]` measures a list of named
views at several viewports in the running sandbox browser and writes JSON plus
a text summary. It uses only `playwright-cli run-code` (no dependencies) and
the signed-in browser of the sandbox, so start `npm run ui:sandbox` (with the
opt-in fixtures the views need) first, in a Board-managed run keep the injected
session, otherwise pass the printed session with `--session`.

```bash
UI_SANDBOX_NOTIFICATIONS_EVAL=1 UI_SANDBOX_TASK_DETAIL_EVAL=1 npm run ui:sandbox
bun run ui:audit -- --views scripts/ui-sandbox/audit-views/notifications.json \
  --label before --out /workspace/group/artifacts/ui-overhaul/notifications --shots
```

Options: `--label` (file names, default `audit`), `--out` (default
`.playwright-cli/ui-audit`, gitignored), `--viewports 1440x900,1366x768,390x844`
(the default; widths under 600px count as mobile), `--only view1,view2`,
`--shots` (one PNG per view and viewport), `--session <name>`.

A views file is `{ "views": [...] }`. Each view has a `name` and optionally:

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route`              | Path with query opened first (default `/`)                                                                                                                                                                                                                                                                                                                       |
| `ready`              | Selector awaited after navigation                                                                                                                                                                                                                                                                                                                                |
| `steps`              | Setup: `click`, `clickAll`, `fill: [sel, text]`, `select: [sel, value]`, `check`, `press`, `hover`, `focus`, `scrollIntoView`, `waitFor`, `wait` (ms); any step takes `unless: <selector>` to skip it when that selector is already visible. Selectors use Playwright syntax (`text=`, `:has-text()`)                                                            |
| `mocks`              | `{url, method?, status?, json?, delayMs?}`: fulfil or delay requests whose path contains `url` (empty, loading and error states). A mock with neither `status` nor `json` only delays; `patch: {match, set}` (or a list of them) fetches the real response and sets dotted paths on every object (at any depth) matching `match` (e.g. enable a project setting) |
| `wsMocks`            | `{url, send: [...]}`: messages pushed as soon as a socket whose path contains `url` opens (JSON-encoded); `"$frame"` becomes a JPEG of a small page. Other sockets reach the real server                                                                                                                                                                         |
| `rows`               | `{scope, until?}`: header-row metric for a toolbar region: stacked rows of controls and text lines, rows holding one lone control, control count and height, plus the row layout (`rows` in the cell JSON)                                                                                                                                                       |
| `toolbar`            | `{pane, toolbar}`: where a tab's toolbar sits in its pane: container left/right inset (right is 0 for tabs that run to the edge, Browser and Mail, whose toolbar pads itself with `pr-2`), first item's inset, gap above (to the tab strip), first row height, median item gap and bottom separator (`toolbar` in the cell JSON)                                 |
| `pairs`              | `{scope?}`: every visible field or select with a button beside it in the same row, with both heights; `mismatched` counts pairs whose heights differ by more than 0.5px (`pairs` in the cell JSON)                                                                                                                                                               |
| `scope`              | Measurement root; default the topmost open dialog or menu, else the page                                                                                                                                                                                                                                                                                         |
| `densityScope`       | Element whose vertical gaps count as dead space (default the scope)                                                                                                                                                                                                                                                                                              |
| `focusWalk`          | `tab` (default for dialogs), `arrows` (menus, where Radix intercepts Tab) or `false`                                                                                                                                                                                                                                                                             |
| `escape`             | `false` to skip the closing Escape check                                                                                                                                                                                                                                                                                                                         |
| `settle`, `settleMs` | `false` skips waiting for spinners and streaming content (loading states)                                                                                                                                                                                                                                                                                        |
| `viewports`          | Restrict to viewport names such as `["1440x900"]`                                                                                                                                                                                                                                                                                                                |
| `keyboardOpen`       | Mobile only: `{height?, focus, probe: {name: selector}}` shrinks the viewport to 508px, focuses `focus` and reports where each probe sits                                                                                                                                                                                                                        |

Per view and viewport it reports, as JSON (`audit-<label>.json`) and a short
table (`audit-<label>-summary.txt`):

- horizontal overflow of the document and the scope, elements off the viewport
  or clipped by a scrolling ancestor;
- truncated text (ellipsis, line clamp, field values wider than the field);
- tap targets under 24px (all controls, every viewport; WCAG 2.2 AA minimum)
  and primary (`bg-primary`) controls under 44px on touch-sized viewports only
  (width <= 480px or `pointer: coarse`; reported as `touchSized`); inline links
  in running text are exempt;
- overlapping text boxes and pills touching neighbouring text;
- text contrast and field/icon contrast from computed colours, alpha blended
  over the real ancestor background (works with oklch and `color-mix`;
  controls hidden at rest with `opacity: 0` are measured as shown);
- focus walk: per reached control whether a ring shows (outline, shadow or
  border change), its contrast from computed colours (browser `outline: auto`
  rings are counted but not contrast-measured), controls that left the scope
  (focus trap), controls never reached, and whether Escape closes the scope;
- density: dead gaps of 32px or more between content blocks, and empty space
  below the content.

The numbers are mechanical: choose the rubric and thresholds in the task that
uses them. App-specific checks (task review findability, history rows, tab
semantics) are deliberately not part of this script. `audit-views/task-detail.json`
reproduces the numbers of the step-5 task-detail audit; `audit-views/notifications.json`
covers the bell, notification dialog and Needs-you forms.
