# cursor-distill

[![npm version](https://img.shields.io/npm/v/cursor-distill)](https://www.npmjs.com/package/cursor-distill)
[![license](https://img.shields.io/npm/l/cursor-distill)](LICENSE)
[![node](https://img.shields.io/node/v/cursor-distill)](package.json)

**Stop repeating yourself to AI agents.**

If you use [Cursor](https://cursor.com) daily, you've probably noticed: the same instructions, the same style corrections, the same multi-step workflows — typed out again and again across dozens of projects and hundreds of sessions.

cursor-distill fixes that. It runs on a schedule, reads your agent transcripts, identifies the patterns you keep repeating, and writes Cursor rules, skills, and subagents for you — so every future session already knows what you want.

---

## The Problem

Cursor agents are powerful, but they start every session with a blank slate (beyond what's in your rules and skills). That means you end up manually re-teaching them:

- "Always use camelCase in JSON"
- "Run the tests before committing"
- "Research this topic and format the output like..."
- "In this project, we deploy by..."

These repeated instructions are scattered across your chat history, never captured as reusable configuration. cursor-distill mines that history and turns it into persistent agent memory.

## What It Creates

- **Skills** — Reusable multi-step workflows your agents can follow
- **Rules** — Persistent preferences and conventions agents always respect
- **Subagents** — Specialized agent prompts for delegatable tasks

Each artifact is scoped either to a single **project** (`.cursor/`) or **globally** (`~/.cursor/`) based on whether the pattern appears in one project or across many.

---

## Prerequisites

- **Node.js 18+**
- **Cursor CLI** — the headless agent that does the actual analysis

Install the Cursor CLI if you haven't already:

```bash
curl https://cursor.com/install -fsS | bash
agent login
```

## Installation

```bash
npm install -g cursor-distill
```

## Quick Start

```bash
# Initialize with a 7-day interval (default)
cursor-distill init

# Or pick your own cadence and model
cursor-distill init --interval 3d --model claude-sonnet-4

# Trigger a run immediately without waiting for the schedule
cursor-distill run --now

# See what's been created
cursor-distill stats
```

That's it. cursor-distill will now check hourly and run the pipeline whenever your configured interval has elapsed.

---

## Commands

### `cursor-distill init`

One-time setup. Safe to re-run — it updates settings without losing your data or custom prompt.

```bash
cursor-distill init [--interval <duration>] [--model <slug>]
```


| Flag         | Default        | Description                                                       |
| ------------ | -------------- | ----------------------------------------------------------------- |
| `--interval` | `7d`           | How often to run. Accepts `d` (days), `h` (hours), `m` (minutes). |
| `--model`    | Cursor default | Which model the headless agent uses for analysis.                 |


What it does:

1. Creates `~/.cursor-distill/` with config and a default classification prompt
2. Verifies the Cursor CLI is installed and authenticated
3. Registers an hourly cron entry (the interval guard inside `run` controls actual cadence)

### `cursor-distill run`

Runs the full pipeline: extract, deduplicate, analyze, write artifacts.

```bash
cursor-distill run [--now]
```

Without `--now`, the command exits immediately if the configured interval hasn't elapsed since the last run. This is how the cron schedule stays lightweight — every hourly tick is a no-op until it's time.

### `cursor-distill stats`

Shows a breakdown of every artifact cursor-distill has created: totals by type and scope, grouped by project, with file paths.

```bash
cursor-distill stats [--json]
```

### `cursor-distill status`

Prints current configuration, schedule state, last run time, next expected run, and whether the Cursor CLI is available.

```bash
cursor-distill status
```

### `cursor-distill uninstall`

Removes the cron schedule. Your config, ledger, and prompt are preserved unless you pass `--purge`.

```bash
cursor-distill uninstall [--purge]
```

---

## Customizing the Prompt

The classification rubric that drives the analysis lives at:

```
~/.cursor-distill/prompt.md
```

This is a plain markdown file that gets sent to the headless agent along with your transcript digest. Edit it to:

- Change classification thresholds (default: 3+ occurrences before creating an artifact)
- Add project-specific conventions or naming rules
- Adjust the tone or format of generated rules and skills
- Add or remove artifact types

cursor-distill will **never overwrite** a customized prompt. It tracks the hash of the default prompt and only refreshes the file if you haven't edited it.

---

## How It Works

```
Transcripts ─── Extract ─── Deduplicate ─── Digest ─── Headless Agent ─── Artifacts
                                                              │
                                                         prompt.md
                                                        (your rubric)
```

1. **Extract** — Walks `~/.cursor/projects/*/agent-transcripts/`, parses JSONL files, and pulls out your messages (not the assistant's). System-injected tags are stripped. Only files newer than the stored watermark are processed.
2. **Deduplicate** — Normalizes and hashes each message to drop near-duplicates, groups the rest by project, and caps the digest at ~100k characters (newest first).
3. **Analyze** — Invokes `agent -p` headlessly with your `prompt.md` rubric + the digest + non-negotiable mechanics (dedup against the ledger, write files directly, emit a manifest).
4. **Record** — Parses the manifest the agent wrote, appends entries to the ledger, and advances per-project watermarks so the next run only sees new transcripts.

---

## Scheduling

cursor-distill uses a single cron entry — identical on macOS and Linux/WSL2:

```
0 * * * * /path/to/node /path/to/cli.js run  # cursor-distill
```

The cron fires **hourly**, but all timing logic lives inside the `run` command's interval guard. If the interval hasn't elapsed, `run` exits in under a millisecond. This design means:

- Changing the interval (`cursor-distill init --interval 3d`) never touches crontab
- Laptop sleep doesn't cause permanently missed runs — the next hourly tick catches up
- **WSL2 note**: cron only fires while the WSL instance is running

---

## Data Directory

Everything cursor-distill persists lives under `~/.cursor-distill/`:

```
~/.cursor-distill/
├── config.json          # interval, model, timestamps
├── prompt.md            # classification rubric (yours to edit)
├── state.json           # per-project watermarks
├── ledger.json          # every artifact created — powers stats and dedup
└── runs/
    └── <run-id>/
        ├── prompt.txt   # the full prompt sent to the agent
        ├── manifest.json # what the agent reported creating
        └── agent.log    # stdout/stderr from the headless run
```

---

## Contributing

Contributions are welcome. Please open an issue before submitting a PR for anything beyond bug fixes.

## License

[MIT](LICENSE)
