export const DEFAULT_EXTRACT_PROMPT = `# Cursor Distill — Message Compression

You are compressing user messages from Cursor agent transcripts into shorter, clearer summaries. Each summary should preserve the full substance of what the user said or demonstrated, just in fewer words.

**Keep all substance.** Preferences, procedures, corrections, requests, clarifications, explanations, debugging steps, architectural decisions — keep it all. Your job is compression, not filtering. The next stage will decide what matters.

**Drop only true filler.** Greetings, acknowledgments ("ok", "thanks", "got it"), and empty back-and-forth with no informational content can be dropped.

**Group related messages.** If several messages form a coherent thread (e.g. a multi-step debugging session, a back-and-forth about a design decision), combine them into a single summary that captures the full conversation arc.

**Be concise but complete.** A 500-word debugging walkthrough should become 2-3 sentences that preserve every step. A one-line preference statement can stay roughly as-is.
`;

export const DEFAULT_SYNTHESIZE_PROMPT = `# Cursor Distill — Artifact Synthesis

You are given condensed summaries of a user's messages from Cursor agent transcripts across many projects. Your job is to identify which summaries contain reusable knowledge, then write Cursor artifacts for them.

**Quality over quantity.** Only create an artifact when a summary captures genuinely reusable knowledge — something the user would benefit from having automated or documented. A single clear instance is enough; do not require multiple sightings.

## Evaluating summaries

For each summary (or group of related summaries), ask:
1. **Is this reusable?** Would the user encounter this situation again? A debugging procedure for a production system = yes. A one-off config tweak = no.
2. **Is there enough detail?** Does the summary contain enough substance to write a useful artifact, or is it too vague?
3. **Does it already exist?** Check the ledger of previously created artifacts.

When multiple summaries describe the same knowledge (possibly worded differently across projects), merge them. Use breadth (distinct projects) to decide scope: knowledge appearing in 3+ projects is likely global; otherwise project-scoped.

## When to create what

You MUST consider all three artifact types. Do not default to rules for everything. A multi-step procedure is a skill, not a rule.

### Rules — for preferences, conventions, and corrections
Short, declarative instructions agents always follow. Use rules for things that can be stated in 1-5 lines.

- **Project rule**: \`<project>/.cursor/rules/<name>.mdc\`
- **Global rule**: \`~/.cursor/rules/<name>.mdc\`

Use \`alwaysApply: true\` when the preference applies to every conversation. Use \`globs:\` when the rule only applies to specific file types.

### Skills — for multi-step workflows and procedures
Skills are the most valuable artifact type. Any summary describing a debugging procedure, investigation workflow, operational runbook, setup sequence, or multi-step process MUST become a skill — not a rule. Skills capture *how* to do something step by step.

- **Project skill**: \`<project>/.cursor/skills/<name>/SKILL.md\`
- **Global skill**: \`~/.cursor/skills/<name>/SKILL.md\`

**Skills default to \`disable-model-invocation: true\`** — they are user-invokable to avoid bloating model context. Only omit this flag if the skill truly needs to be in every conversation's context (rare).

Write skills with enough detail that an agent can follow the procedure autonomously: which databases/tables to check, which repos to look at, which commands to run, what to look for at each step.

### Subagents — for delegable tasks with a consistent format
Self-contained tasks with a consistent persona, methodology, or output shape.

- **Project subagent**: \`<project>/.cursor/agents/<name>.md\`
- **Global subagent**: \`~/.cursor/agents/<name>.md\`

## Writing artifacts

You are a Cursor agent — read existing rules, skills, and agents in the user's \`~/.cursor/\` and project \`.cursor/\` directories to understand conventions already in use. Match their style.

- **Edit over create.** If an existing artifact covers the topic, update it instead of making a new one.
- **Check the ledger.** Previously created artifacts are listed in the mechanics section. Don't duplicate them.
- **Be concise.** Rules: 1-5 lines. Skills: under 500 lines. Subagents: focused and specific.
- **Use lowercase-kebab-case** for all artifact names.

## Project workspace resolution

Project slugs follow the pattern \`Users-<user>-<path-segments>\`. To resolve:
- Replace \`Users-<user>-\` with the home directory
- Replace remaining \`-\` with path separators
- Example: \`Users-jane-projects-myapp\` → \`~/projects/myapp\`
`;
