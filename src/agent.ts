import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPromptFile, readLedger } from "./store.js";
import {
  DEFAULT_EXTRACT_PROMPT,
  DEFAULT_SYNTHESIZE_PROMPT,
} from "./defaultPrompts.js";
import type { Chunk } from "./extract.js";
import { resolveAllProjectSlugs } from "./extract.js";

const AGENT_CANDIDATES = ["agent", "cursor-agent"] as const;

/** Per-agent subprocess deadline (15 minutes). */
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 10_000;

let cachedAgentPath: string | null | undefined;

/** Live agent subprocesses — killed on Ctrl+C so they don't outlive the CLI. */
const activeAgents = new Set<ChildProcess>();

/** SIGTERM all in-flight agent children (used by the SIGINT handler). */
export function killActiveAgents(): void {
  for (const proc of activeAgents) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
  activeAgents.clear();
}

const VALID_TYPES = new Set(["rule", "skill", "subagent"]);
const VALID_SCOPES = new Set(["global", "project"]);
const VALID_ACTIONS = new Set(["created", "edited"]);

/** A condensed summary of user messages from one chunk. */
export interface Observation {
  summary: string;
  project: string;
  evidence: string[];
}

/** Result of extracting a single chunk — observations on success, error otherwise. */
export interface ChunkOutcome {
  observations: Observation[];
  elapsed: string;
  error?: string;
}

/** A single artifact proposed by the synthesis stage, including file content. */
export interface AgentEntry {
  type: "rule" | "skill" | "subagent";
  scope: "global" | "project";
  path: string;
  action: "created" | "edited";
  content: string;
  sourcePattern: string;
}

/** Outcome of the synthesis stage. */
export interface SynthesisResult {
  entries: AgentEntry[];
  success: boolean;
  error?: string;
}

interface SpawnResult {
  stdout: string;
  success: boolean;
  error?: string;
}

/** Caches the extract prompt so parallel chunk calls don't re-read the file. */
let cachedExtractPrompt: string | undefined;

/** Runs extraction on a single chunk. Failed or unparseable chunks return an error and no observations. */
export async function runSingleChunk(
  chunk: Chunk,
  index: number,
  model: string,
  runDir: string,
  agentPath?: string,
): Promise<ChunkOutcome> {
  if (cachedExtractPrompt === undefined) {
    cachedExtractPrompt = (await readPromptFile("extract")) ?? DEFAULT_EXTRACT_PROMPT;
  }

  const logPath = join(runDir, `extract-${index}.log`);
  const prompt = buildExtractPrompt(cachedExtractPrompt, chunk);
  const start = Date.now();
  const result = await spawnAgent(prompt, model, logPath, agentPath);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!result.success) {
    return { elapsed, error: result.error, observations: [] };
  }

  const parsed = parseAgentOutput(result.stdout);
  if (parsed === null) {
    return { elapsed, error: "no valid JSON", observations: [] };
  }

  return {
    elapsed,
    observations: validateObservations(parsed, chunk.project),
  };
}

/** Writes collected observations to the run directory. */
export async function saveObservations(
  observations: Observation[],
  runDir: string,
): Promise<void> {
  await writeFile(
    join(runDir, "observations.json"),
    JSON.stringify(observations, null, 2),
  );
}

/**
 * Stage 2: runs the synthesis model once over all observations.
 * Invalid entries are dropped with a warning; valid ones are kept.
 */
export async function runSynthesis(
  observations: Observation[],
  model: string,
  runDir: string,
  agentPath?: string,
): Promise<SynthesisResult> {
  const userPrompt =
    (await readPromptFile("synthesize")) ?? DEFAULT_SYNTHESIZE_PROMPT;
  const prompt = await buildSynthesizePrompt(userPrompt, observations);
  await writeFile(join(runDir, "synthesize-prompt.txt"), prompt);

  const result = await spawnAgent(prompt, model, join(runDir, "synthesize.log"), agentPath);

  if (!result.success) {
    return { entries: [], success: false, error: result.error };
  }

  const parsed = parseAgentOutput(result.stdout);
  if (parsed === null) {
    return {
      entries: [],
      success: false,
      error: "No valid JSON array found in synthesis output",
    };
  }

  const validated = validateEntries(parsed);

  await writeFile(
    join(runDir, "response.json"),
    JSON.stringify(validated, null, 2),
  );
  return { entries: validated, success: true };
}

/**
 * Absolute path of the first Cursor agent CLI on PATH, or null if neither
 * `agent` nor `cursor-agent` is installed. Result is cached after first call.
 */
export function resolveAgentCli(): string | null {
  if (cachedAgentPath !== undefined) return cachedAgentPath;
  for (const cmd of AGENT_CANDIDATES) {
    try {
      cachedAgentPath = execSync(`command -v ${cmd}`, { encoding: "utf-8" }).trim();
      return cachedAgentPath;
    } catch {
      // continue
    }
  }
  cachedAgentPath = null;
  return null;
}

/**
 * Spawns the Cursor CLI headlessly in read-only mode, writing the prompt
 * to stdin (argv has a 128KB per-argument limit on Linux/WSL2).
 * Enforces AGENT_TIMEOUT_MS; sends SIGTERM then SIGKILL after a grace period.
 */
function spawnAgent(
  prompt: string,
  model: string,
  logPath: string,
  agentPath?: string,
): Promise<SpawnResult> {
  const agentCmd = agentPath ?? resolveAgentCli() ?? "agent";
  const args = ["-p", "--mode", "ask", "--trust", "--output-format", "json", "--model", model];

  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function finish(result: SpawnResult): void {
      if (settled) return;
      settled = true;
      activeAgents.delete(proc);
      clearTimeout(timer);
      clearTimeout(killTimer);
      writeFile(logPath, buildLog(result, stdout, stderr)).catch(() => {});
      resolve(result);
    }

    const proc = spawn(agentCmd, args, {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeAgents.add(proc);

    proc.stdin.on("error", () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");

    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // On timeout: SIGTERM, then SIGKILL after grace. Resolve only on close so
    // finish() does not clear the kill timer before SIGKILL can fire.
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
    }, AGENT_TIMEOUT_MS);

    proc.on("close", (code) => {
      if (timedOut) {
        finish({
          stdout,
          success: false,
          error: `Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`,
        });
        return;
      }
      finish(
        code !== 0
          ? { stdout, success: false, error: `Agent exited with code ${code}` }
          : { stdout, success: true },
      );
    });

    proc.on("error", (err) => {
      finish({ stdout: "", success: false, error: err.message });
    });
  });
}

function buildLog(result: SpawnResult, stdout: string, stderr: string): string {
  const status = result.success ? "OK" : `FAILED: ${result.error}`;
  return `STATUS: ${status}\n\n--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`;
}

/** Assembles the extraction prompt: user rubric + compression contract + chunk. */
function buildExtractPrompt(userPrompt: string, chunk: Chunk): string {
  const mechanics = `
---
## System Instructions (non-negotiable)

**Do NOT write any files to disk.** Return your entire response as a single JSON array printed to stdout.

Each element is one condensed summary:

\`\`\`json
[
  {
    "summary": "User debugs site assignment issues by first checking the site_assignments table in MySQL for the affected site ID, then tracing the assignment code path in sol/pkg/assignments/handler.go to find where the logic diverges",
    "evidence": ["check the site_assignments table first", "look at sol/pkg/assignments/handler.go for the assignment logic"]
  }
]
\`\`\`

Required fields:
- **summary**: a concise rewrite of what the user said, taught, or demonstrated — preserving all substance
- **evidence**: 1-5 short excerpts from the user's actual messages (direct quotes)

If every message is pure filler with no substance, return an empty array: \`[]\`

**Only output the JSON array. No prose before or after.**
`;

  return `${userPrompt}
${mechanics}
---
# User Messages — Project: ${chunk.project} (${chunk.messageCount} messages)

${chunk.text}`;
}

/** Assembles the synthesis prompt: user rubric + artifact contract + ledger + observations. */
async function buildSynthesizePrompt(
  userPrompt: string,
  observations: Observation[],
): Promise<string> {
  const ledger = await readLedger();

  const slugs = [...new Set(observations.map((o) => o.project))];
  const slugMap = resolveAllProjectSlugs(slugs);

  const mechanics = `
---
## System Instructions (non-negotiable)

**Do NOT write any files to disk.** Return your entire response as a single JSON array printed to stdout.

Each element in the array represents one artifact to create or edit:

\`\`\`json
[
  {
    "type": "rule",
    "scope": "global",
    "path": "~/.cursor/rules/example.mdc",
    "action": "created",
    "content": "---\\nalwaysApply: true\\n---\\n# Example\\n\\nConcise instruction.",
    "sourcePattern": "User demonstrated camelCase JSON preference across multiple projects"
  }
]
\`\`\`

Required fields:
- **type**: one of "rule", "skill", "subagent"
- **scope**: one of "global", "project"
- **path**: full file path (use ~ for home directory)
- **action**: "created" or "edited"
- **content**: the complete file contents to write
- **sourcePattern**: short description of the knowledge that triggered this artifact

If nothing warrants creation, return an empty array: \`[]\`

**Do not write any files yourself. Do not create directories. Only output the JSON array.**

### Project workspace resolution

Use this pre-resolved mapping for project-scoped artifact paths — do NOT attempt your own slug decoding:
${JSON.stringify(slugMap, null, 2)}

Slugs not listed above could not be resolved to an existing directory. Do not create project-scoped artifacts for unresolved slugs.

Previously created artifacts (check before duplicating):
${JSON.stringify(ledger.map((e) => ({ type: e.type, scope: e.scope, path: e.path })), null, 2)}
`;

  return `${userPrompt}
${mechanics}
---
# Condensed Summaries

${observations.length} summaries condensed from per-project message batches. Each preserves the substance of what the user said — no pre-classification has been applied. It is your job to decide what (if anything) is worth turning into an artifact, what type it should be, and how to scope it. Merge summaries that describe the same knowledge across projects.

${JSON.stringify(observations, null, 2)}`;
}

/**
 * Extracts the first valid JSON array from agent text.
 * Handles markdown fences and surrounding prose.
 */
export function extractJson(stdout: string): unknown[] | null {
  const candidates = [stdout.trim()];

  const fenceMatch = stdout.match(/```(?:json)?\s*\n(\[[\s\S]*?\])\s*\n```/);
  if (fenceMatch) candidates.push(fenceMatch[1]);

  const bracketStart = stdout.indexOf("[");
  const bracketEnd = stdout.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    candidates.push(stdout.slice(bracketStart, bracketEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Parses Cursor CLI `--output-format json` stdout.
 * Envelope shape: `{ "type": "result", "result": "<model text>" }`.
 * Falls back to raw extractJson when the envelope is absent (older CLI).
 */
export function parseAgentOutput(stdout: string): unknown[] | null {
  try {
    const envelope = JSON.parse(stdout);
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      !Array.isArray(envelope) &&
      envelope.type === "result" &&
      typeof envelope.result === "string"
    ) {
      return extractJson(envelope.result);
    }
  } catch {
    // Not a JSON envelope — fall through to raw parse.
  }
  return extractJson(stdout);
}

/**
 * Validates observations leniently — invalid items are dropped, valid ones
 * kept. The project field is stamped from the chunk, not trusted from the model.
 */
function validateObservations(raw: unknown[], project: string): Observation[] {
  const valid: Observation[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;

    if (typeof o.summary !== "string" || o.summary.length === 0) continue;

    valid.push({
      summary: o.summary,
      project,
      evidence: Array.isArray(o.evidence)
        ? o.evidence.filter((e): e is string => typeof e === "string")
        : [],
    });
  }

  return valid;
}

/**
 * Validates entries leniently — invalid items are dropped with a warning,
 * valid ones kept. Mirrors the lenient approach used in validateObservations.
 */
function validateEntries(raw: unknown[]): AgentEntry[] {
  const validated: AgentEntry[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      console.warn("  Dropped synthesis entry: not an object");
      continue;
    }
    const e = item as Record<string, unknown>;

    if (typeof e.type !== "string" || !VALID_TYPES.has(e.type)) {
      console.warn(`  Dropped synthesis entry: invalid type "${String(e.type)}"`);
      continue;
    }
    if (typeof e.scope !== "string" || !VALID_SCOPES.has(e.scope)) {
      console.warn(`  Dropped synthesis entry: invalid scope "${String(e.scope)}"`);
      continue;
    }
    if (typeof e.action !== "string" || !VALID_ACTIONS.has(e.action)) {
      console.warn(`  Dropped synthesis entry: invalid action "${String(e.action)}"`);
      continue;
    }
    if (typeof e.path !== "string" || e.path.length === 0) {
      console.warn("  Dropped synthesis entry: missing path");
      continue;
    }
    if (typeof e.content !== "string" || e.content.length === 0) {
      console.warn(`  Dropped synthesis entry: missing content for ${e.path}`);
      continue;
    }
    if (typeof e.sourcePattern !== "string") {
      console.warn(`  Dropped synthesis entry: missing sourcePattern for ${e.path}`);
      continue;
    }

    validated.push({
      type: e.type as AgentEntry["type"],
      scope: e.scope as AgentEntry["scope"],
      path: e.path,
      action: e.action as AgentEntry["action"],
      content: e.content,
      sourcePattern: e.sourcePattern,
    });
  }

  return validated;
}
