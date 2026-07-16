# cursor-distill

**Stop repeating yourself to AI agents.**

cursor-distill reads your [Cursor](https://cursor.com) chat history on a schedule, finds instructions you keep repeating, and turns them into persistent **rules**, **skills**, and **subagents** — scoped per-project or globally.

## Install

```bash
npm install -g cursor-distill
```

Requires Node 18+ and the [Cursor CLI](https://cursor.com/docs/cli/headless). Windows users can use on WSL2.

## Quick Start

```bash
cursor-distill init                  # setup with 7-day default
cursor-distill init --interval 3d --model claude-sonnet-4  # or customize
cursor-distill run --now             # run immediately
cursor-distill stats                 # see what was created
```

## Commands


| Command                                 | Description                                                         |
| --------------------------------------- | ------------------------------------------------------------------- |
| `init [--interval 7d] [--model <slug>]` | Setup config, prompt, and cron schedule                             |
| `run [--now]`                           | Run the pipeline (skips if interval hasn't elapsed, unless `--now`) |
| `stats [--json]`                        | Show all created artifacts by type, scope, and project              |
| `status`                                | Show config, schedule, last run, and CLI availability               |
| `uninstall [--purge]`                   | Remove cron entry; `--purge` deletes all data                       |


## How It Works

1. **Extract** — Pulls your messages from `~/.cursor/projects/*/agent-transcripts/`, skipping files already processed
2. **Deduplicate** — Hashes and groups messages by project, capped at ~100k chars
3. **Analyze** — Sends the digest to a headless Cursor agent with a classification rubric
4. **Write** — The agent creates rules, skills, and subagents directly on disk

A cron entry fires hourly; an internal interval guard keeps actual runs at your configured cadence.

## Custom Prompt

The rubric driving classification lives at `~/.cursor-distill/prompt.md`. Edit it to change thresholds, naming conventions, or artifact formats. cursor-distill never overwrites a customized prompt.

## Data

```
~/.cursor-distill/
├── config.json    # interval, model
├── prompt.md      # classification rubric (edit this)
├── state.json     # per-project watermarks
├── ledger.json    # artifact log (powers stats + dedup)
└── runs/<id>/     # prompt, manifest, and agent log per run
```

## License

[MIT](LICENSE)
