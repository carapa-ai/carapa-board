# Distributed agent skills

The shared agent skills and rules are not stored in this repository. Their only
source is the **carapa-agent-kit** repository (`carapa-ai/carapa-agent-kit`,
branch `main`, Apache-2.0):

```text
carapa-agent-kit/
├── platform/{skills,rules}/    every sandbox, group, objective and repository run
├── brain/group/{skills,rules}/      CarapaBrain sandboxes: the project's group agent
├── brain/objective/{skills,rules}/  CarapaBrain objective template
└── scripts/install.sh          installer (with its layout-migration helper)
```

Skills are stored as `<name>/SKILL.md` plus supporting files. The setup skill
here owns only the installation workflow (`scripts/quick-install.sh`) and this
guide. Repository skills under `.agent/skills/` (`setup`, `debug`) work on
CarapaBoard itself and are never copied into the agent home.

## Changing kit content

Kit content is changed in the `carapa-agent-kit` repository, not in this one. The
Board settings `PROMOTION_KIT_REPO_DIR` and `PROMOTION_KIT_BRANCH` name the
kit checkout (and its branch) that the `propose_changes` tool commits approved
proposals to.

The transcripts skill bundles Board code. After changing
`src/modules/transcripts/`, regenerate its CLI into a kit checkout with
`bun run build:transcripts-skill -- --kit <path-to-kit>` (the default is
`../carapa-agent-kit`) and commit it in the kit.

## Platform rules

`platform/rules/*.md` are rules that hold in every CarapaBox sandbox, for every
group, objective, and repository run. `install.sh` installs them into
`AGENT_HOME/.agent/rules` (Claude reads it as `.claude/rules`; the runtime
renders it into `AGENTS.override.md` for other harnesses) and backs up changed
copies. Rule files it does not distribute are never removed.

Agent rules load in three layers: these platform rules, then the project
group's `/workspace/group/.agent/rules`, then the run's cwd (an objective folder
or a repository). A same-named file in a deeper layer replaces a shallower one
for generated overrides. Keep group-specific rules in the group, objective
mechanics in the kit's `brain/objective/` template, and project-only rules in the
repository's own `AGENTS.md` or `.agent/rules`.

## Install or update

Quick-install clones the kit to `$INSTALL_DIR/carapa-agent-kit` (always `main`,
whatever `--branch` says, because the kit has only `main`) and runs the
installer after repairing agent-home ownership; setup also runs it for an
existing installation. Manually, from the kit checkout, use the actual
agent-home bind-mount source:

```sh
bash scripts/install.sh --agent-home /absolute/path/to/agent-home
bash scripts/install.sh --agent-home /absolute/path/to/agent-home --check
```

The command also accepts `AGENT_HOME`, or the installer's `AGENT_HOME_DIR`, when
`--agent-home` is omitted. It never defaults to the developer's home directory.
It locates the kit relative to the script, independent of CWD.

Each platform skill is installed once into the real `.agent/skills/` directory
under the selected agent home, mounted as `/home/ubuntu` in the sandbox.
Harness discovery aliases are relative symlinks: `.claude/skills` and
`.codex/skills` point to `../.agent/skills`; `.agents` points to `.agent`.
Installation requires Python 3 for layout migration. Legacy directories and
an existing `.agent -> .claude` alias are migrated with backups. Unrelated
skills and non-skill guidance are retained; same-path conflicts prefer `.agent`,
then `.agents`, then Claude, then Codex, with all previous entries saved in the
reported backup directory (`paths.txt` maps original locations). Existing CLI
authentication files remain at their harness locations. `--check` validates
both content and the alias layout without writing files. Only distributed
skill names are replaced. Other skills and CLI authentication/configuration are
preserved. Changed prior copies are backed up under
`AGENT_HOME/.carapa/skill-backups/`; unchanged copies are skipped. Existing `.git`
and `node_modules` entries are retained when updating an installed skill; caches
and dependency directories are not compared as canonical skill content.

Obsolete source files inside a replaced skill are removed, but skills removed
entirely from the kit are not automatically deleted from agent home. `--check`
is read-only and returns nonzero if a distributed skill differs, is missing, or the layout is incorrect.
Do not run concurrent installs against the same agent home.

The installer always installs `brain/group/` into `AGENT_HOME/.agent/scopes/group/`
and `brain/objective/` into `AGENT_HOME/.agent/scopes/objective/`; sandboxes that
run CarapaBrain link these
from the agent home instead of receiving copies. Template skills ship as
`SKILL.md`; `.agent/scopes` is not a harness discovery path. Unlike
`.agent/rules`, each scope `rules` and `skills` directory is fully owned by the
installer: files absent from the source are removed, with the previous directory
backed up under `AGENT_HOME/.carapa/skill-backups/`. `--check` reports
out-of-date scope directories with the same exit codes.

Installation does not install skill-specific runtime dependencies. For
example, a fresh `video-showcase` installation needs its declared npm dependencies
before recording; use its package lock and skill instructions when that workflow
is needed. Installed copies are validated skill packages, not proof that browsers,
TTS services, credentials, or other external runtimes are ready.

After copying host CLI directories during auth setup, install again so their
skill snapshots cannot override the kit distribution. Existing agent sessions
may have already read older instructions; reload the skill or start a fresh run.

`bin/quick-install.sh` remains only as a compatibility bootstrap for the published
installation URL. It delegates to setup's canonical script locally or downloads
that script for the original `curl | bash` entrypoint. There is one installer
implementation; new internal callers use `setup/scripts/quick-install.sh`.
