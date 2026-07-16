# cursor-distill

**Turn your Cursor chat history into persistent rules, skills, and subagents.**

cursor-distill reads your [Cursor](https://cursor.com) agent transcripts on a schedule, identifies reusable knowledge — debugging workflows, coding conventions, operational procedures — and packages them as Cursor artifacts scoped per-project or globally.

A single debugging walkthrough you did last week becomes a skill agents can follow next time. A preference you stated once becomes a rule they always respect.

## Install

```bash
npm install -g cursor-distill
```

Requires Node 18+ and the [Cursor CLI](https://cursor.com/docs/cli/headless). Windows users: use WSL2.

## Quick Start

```bash
cursor-distill init                     # setup with defaults
cursor-distill run --now                # run immediately
cursor-distill stats                    # see what was created
```

Customize models and interval:

```bash
cursor-distill init \
  --interval 3d \
  --extract-model gemini-3.5-flash \
  --synthesize-model claude-opus-4-8-thinking-high
```

## Commands

| Command | Description |
| --- | --- |
| `init` | Setup config, prompts, and cron schedule |
| `run [--now]` | Run the pipeline (skips if interval hasn't elapsed, unless `--now`) |
| `stats [--json]` | Show all created artifacts by type, scope, and project |
| `status` | Show config, schedule, last run, and CLI availability |
| `uninstall [--purge]` | Remove cron entry; `--purge` deletes all data |

### Init Options

| Flag | Default | Description |
| --- | --- | --- |
| `--interval <duration>` | `7d` | How often to run (e.g. `7d`, `3d`, `12h`) |
| `--extract-model <slug>` | `gemini-3.5-flash` | Fast model for knowledge extraction |
| `--synthesize-model <slug>` | `claude-opus-4-8-thinking-high` | Smart model for artifact synthesis |

## Custom Prompts

Two prompt files control cursor-distill's judgment — edit them to tune what gets created:

```
~/.cursor-distill/prompts/
├── extract.md      # what counts as reusable knowledge
└── synthesize.md   # when to create rules vs skills vs subagents
```

cursor-distill never overwrites a customized prompt. The output contracts (JSON schemas) are hardcoded and not user-editable — this keeps file writing deterministic.

## How It Works

cursor-distill uses a two-stage pipeline in a single scheduled run:

1. **Extract transcripts** — Pulls your messages from `~/.cursor/projects/*/agent-transcripts/`, skipping files already processed
2. **Chunk by project** — Deduplicates and groups messages per project, splitting large projects into chunks (~100K words each)
3. **Extract knowledge** (Stage 1) — A fast model scans each chunk in parallel, identifying reusable knowledge: procedures you demonstrated, conventions you declared, tasks you delegated with a consistent format
4. **Synthesize artifacts** (Stage 2) — A smart model evaluates all observations, merges duplicates across projects, and decides which warrant a Cursor artifact — then writes the complete file contents
5. **Validate and write** — The CLI validates the structured output, writes files to disk, and records everything in the ledger

The agent runs in read-only mode (`--mode ask`) and never writes files directly. All file I/O is deterministic — if validation fails, nothing is written.

A cron entry fires hourly; an internal interval guard keeps actual runs at your configured cadence.

## What It Creates

- **Rules** (`.mdc`) — Short, declarative preferences and conventions. `alwaysApply: true` for things agents should always follow.
- **Skills** (`SKILL.md`) — Multi-step procedures and workflows you've demonstrated. Default to user-invokable (`disable-model-invocation: true`) to avoid bloating agent context.
- **Subagents** (`.md`) — Delegable tasks with a consistent persona or output format.

Each artifact is scoped either to a specific project or globally, based on whether the knowledge appeared across multiple projects.

## Data

```
~/.cursor-distill/
├── config.json        # interval, models
├── state.json         # per-project watermarks
├── ledger.json        # artifact log (powers stats + dedup)
├── prompts/
│   ├── extract.md     # extraction rubric (edit this)
│   └── synthesize.md  # synthesis rubric (edit this)
└── runs/<id>/
    ├── extract-*.log  # per-chunk extraction logs
    ├── observations.json
    ├── synthesize.log
    └── response.json
```

## License

[MIT](LICENSE)
