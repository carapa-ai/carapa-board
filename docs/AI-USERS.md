# Virtual AI users

Administrators manage virtual conversation participants from **Admin → AI Users**.
Metadata and conversation membership are stored in the database. The editable
prompt and avatar files live under:

```text
<DATA_DIR>/ai-users/<id>/prompt-<uuid>.md
<DATA_DIR>/ai-users/<id>/avatar.png
```

Every saved prompt edit writes a new `prompt-<uuid>.md` file, and the database row points at the current one; there is no fixed `prompt.md`.

Prompts use a small, validated frontmatter format:

```md
---
identity: 'Researcher Luna'
turn: after
tools:
  - transcripts
  - web
---

You are an evidence-focused participant...
```

- `identity` is required and becomes the visible chat name.
- `turn` is `before` or `after` the main agent and defaults to `after`.
- `tools` lists registered CarapaBoard toolsets. Omission means core-only.

## Assisted persona and avatar drafting

The editor can ask the configured default chat model to improve the complete
persona Markdown or draft a square-avatar image prompt. These actions only fill
editable form fields:

- **Improve persona with AI** returns validated Markdown and synchronizes the
  turn and toolset controls. It never writes the prompt file or database row.
- **Draft avatar prompt with AI** proposes editable visual direction. It never
  invokes image generation.
- The administrator must explicitly click **Save** to persist persona changes
  and **Generate new avatar** to submit the reviewed image prompt. A new AI user
  must be saved before an avatar can be generated.
- Once a base avatar exists, **Modify current avatar** sends that saved image
  to the image model (Gemini) as the edit reference and uses the avatar prompt as modification
  instructions. Generated images are stored as candidates and shown beside the
  current avatar. **Keep current** discards only the candidate; **Use new
  avatar** archives the old image under a timestamped filename and promotes the
  candidate, so the base image can be reviewed before deriving emotes.
- Avatar generation uses the provider's fastest supported square quality and
  keeps the original 1024px square result. Providers currently do not accept
  a native 400×400 generation canvas.
- Generation runs as an in-process background job after the API accepts it.
  Leaving or closing the admin page does not cancel the job; reopening the AI
  user reconnects to its status and refreshes the avatar after completion. A
  CarapaBoard process restart still interrupts an in-flight generation.

For Direct LLM runtimes, the board expands these toolsets into an exact tool
allowlist and excludes `load_toolset`, so the participant cannot expand its own
permissions. Project-disabled toolsets always remain disabled. CLI harnesses
receive the same restriction in their system prompt, but provider-native tools
that the CLI exposes independently must also be restricted in that provider's
own configuration; CarapaBoard does not claim enforcement over tools outside
its MCP/tool registry.

AI users are invited per conversation from the composer runtime menu. Any
conversation member can invite, pause, resume, or remove them. Pausing takes
effect at the next turn boundary; an already-running turn is allowed to finish.

The same menu also has a **Main participant** selector. Choosing an AI persona
replaces the default main chat agent for that conversation: its preset runs the
main streamed response with its identity prompt, tool allowlist, sender name,
avatar, and an isolated session. A main persona is removed from the invited
roster so it cannot speak twice in the same talking-stick cycle. Selecting
**Project default** restores the project's default main participant, and **No
persona** runs the conversation without a persona.
