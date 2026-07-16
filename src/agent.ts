import { spawn, execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPromptFile, readLedger } from "./store.js";
import {
  DEFAULT_EXTRACT_PROMPT,
  DEFAULT_SYNTHESIZE_PROMPT,
} from "./defaultPrompts.js";
import type { Chunk } from "./extract.js";

const AGENT_CANDIDATES = ["agent", "cursor-agent"] as const;

/** How many extraction agents run at once. */
const EXTRACT_CONCURRENCY = 4;

const VALID_TYPES = new Set(["rule", "skill", "subagent"]);
const VALID_SCOPES = new Set(["global", "project"]);
const VALID_ACTIONS = new Set(["created", "edited"]);

const VALID_INVOCATIONS = new Set(["user", "agent"]);
const VALID_CONFIDENCES = new Set(["high", "medium"]);

/** A piece of reusable knowledge extracted from one chunk of messages. */
export interface Observation {
  insight: string;
  typeGuess: "rule" | "skill" | "subagent";
  invocation: "user" | "agent";
  confidence: "high" | "medium";
  project: string;
  evidence: string[];
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

/**
 * Stage 1: runs the extraction model over every chunk with bounded
 * concurrency. Failed or unparseable chunks are skipped with a warning —
 * extraction is lossy by design; synthesis is where strictness matters.
 */
export async function runExtraction(
  chunks: Chunk[],
  model: string,
  runDir: string,
): Promise<Observation[]> {
  const userPrompt = (await readPromptFile("extract")) ?? DEFAULT_EXTRACT_PROMPT;
  const observations: Observation[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < chunks.length) {
      const index = nextIndex++;
      const chunk = chunks[index];
      const logPath = join(runDir, `extract-${index}.log`);
      const prompt = buildExtractPrompt(userPrompt, chunk);

      const name = truncateProject(chunk.project);
      console.log(`  [started] ${name} (${chunk.messageCount} messages)`);
      const start = Date.now();
      const result = await spawnAgent(prompt, model, logPath);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (!result.success) {
        console.warn(`  [failed]  ${name} — ${result.error} (${elapsed}s)`);
        continue;
      }

      const parsed = extractJson(result.stdout);
      if (parsed === null) {
        console.warn(`  [failed]  ${name} — no valid JSON (${elapsed}s)`);
        continue;
      }

      const valid = validateObservations(parsed, chunk.project);
      observations.push(...valid);
      console.log(`  [done]    ${name} → ${valid.length} observation(s) (${elapsed}s)`);
    }
  }

  const workers = Array.from(
    { length: Math.min(EXTRACT_CONCURRENCY, chunks.length) },
    () => worker(),
  );
  await Promise.all(workers);

  await writeFile(
    join(runDir, "observations.json"),
    JSON.stringify(observations, null, 2),
  );

  return observations;
}

/**
 * Stage 2: runs the synthesis model once over all observations.
 * Validation is strict — any invalid entry aborts the run with no writes.
 */
export async function runSynthesis(
  observations: Observation[],
  model: string,
  runDir: string,
): Promise<SynthesisResult> {
  const userPrompt =
    (await readPromptFile("synthesize")) ?? DEFAULT_SYNTHESIZE_PROMPT;
  const prompt = await buildSynthesizePrompt(userPrompt, observations);
  await writeFile(join(runDir, "synthesize-prompt.txt"), prompt);

  console.log(`  Analyzing ${observations.length} observation(s)...`);
  const start = Date.now();
  const result = await spawnAgent(prompt, model, join(runDir, "synthesize.log"));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!result.success) {
    console.error(`  FAILED (${elapsed}s): ${result.error}`);
    return { entries: [], success: false, error: result.error };
  }
  console.log(`  Synthesis complete (${elapsed}s).`);

  const parsed = extractJson(result.stdout);
  if (parsed === null) {
    return {
      entries: [],
      success: false,
      error: "No valid JSON array found in synthesis output",
    };
  }

  const validated = validateEntries(parsed);
  if (validated === null) {
    return {
      entries: [],
      success: false,
      error: "Synthesis returned entries with missing or invalid fields",
    };
  }

  await writeFile(
    join(runDir, "response.json"),
    JSON.stringify(validated, null, 2),
  );
  return { entries: validated, success: true };
}

/**
 * Absolute path of the first Cursor agent CLI on PATH, or null if neither
 * `agent` nor `cursor-agent` is installed.
 */
export function resolveAgentCli(): string | null {
  for (const cmd of AGENT_CANDIDATES) {
    try {
      return execSync(`command -v ${cmd}`, { encoding: "utf-8" }).trim();
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Spawns the Cursor CLI headlessly in read-only mode, writing the prompt
 * to stdin (argv has a 128KB per-argument limit on Linux/WSL2).
 */
function spawnAgent(
  prompt: string,
  model: string,
  logPath: string,
): Promise<SpawnResult> {
  const agentCmd = resolveAgentCli() ?? "agent";
  const args = ["-p", "--mode", "ask", "--trust", "--model", model];

  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(agentCmd, args, {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.on("error", () => {
      // Child exited before reading all input; close handler reports it.
    });
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", async (code) => {
      const log = `EXIT CODE: ${code}\n\n--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`;
      await writeFile(logPath, log);

      if (code !== 0) {
        resolve({
          stdout,
          success: false,
          error: `Agent exited with code ${code}`,
        });
        return;
      }
      resolve({ stdout, success: true });
    });

    proc.on("error", async (err) => {
      await writeFile(logPath, `SPAWN ERROR: ${err.message}`);
      resolve({ stdout: "", success: false, error: err.message });
    });
  });
}

/** Assembles the extraction prompt: user rubric + observation contract + chunk. */
function buildExtractPrompt(userPrompt: string, chunk: Chunk): string {
  const mechanics = `
---
## System Instructions (non-negotiable)

**Do NOT write any files to disk.** Return your entire response as a single JSON array printed to stdout.

Each element is one piece of reusable knowledge you identified:

\`\`\`json
[
  {
    "insight": "User debugs site assignment issues by checking the assignments table in MySQL, then tracing the code path in the sol repo's assignment handler",
    "typeGuess": "skill",
    "invocation": "user",
    "confidence": "high",
    "evidence": ["check the site_assignments table first", "look at sol/pkg/assignments/handler.go for the assignment logic"]
  }
]
\`\`\`

Required fields:
- **insight**: what the user taught or demonstrated — a clear description of the knowledge
- **typeGuess**: one of "rule", "skill", "subagent"
- **invocation**: "user" (default — user triggers when needed) or "agent" (must always be in agent context, only for universal conventions)
- **confidence**: "high" (clear intentional teaching moment or explicit declaration) or "medium" (reasonable inference from context)
- **evidence**: 1-5 short excerpts from the user's actual messages showing the knowledge

If no reusable knowledge is found, return an empty array: \`[]\`

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

Previously created artifacts (check before duplicating):
${JSON.stringify(ledger.map((e) => ({ type: e.type, scope: e.scope, path: e.path })), null, 2)}
`;

  return `${userPrompt}
${mechanics}
---
# Observations

${observations.length} observations extracted from per-project message batches. Each captures a piece of reusable knowledge the user demonstrated or declared. Merge observations that describe the same knowledge (they may be worded differently across projects). Use the "invocation" field to determine \`disable-model-invocation\` (skills) and \`alwaysApply\` (rules). Prefer "user" invocation for skills.

${JSON.stringify(observations, null, 2)}`;
}

/**
 * Extracts the first valid JSON array from the agent's stdout.
 * Shortens a project slug like "Users-aidenhadisi-ezoicgit-funneljam" to "funneljam".
 */
function truncateProject(slug: string): string {
  const parts = slug.split("-");
  return parts.length > 2 ? parts.slice(2).join("-") : slug;
}

/**
 * Handles cases where the agent wraps JSON in markdown code fences or adds prose.
 */
function extractJson(stdout: string): unknown[] | null {
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
 * Validates observations leniently — invalid items are dropped, valid ones
 * kept. The project field is stamped from the chunk, not trusted from the model.
 */
function validateObservations(raw: unknown[], project: string): Observation[] {
  const valid: Observation[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;

    if (typeof o.insight !== "string" || o.insight.length === 0) continue;
    if (typeof o.typeGuess !== "string" || !VALID_TYPES.has(o.typeGuess)) continue;
    if (!Array.isArray(o.evidence)) continue;

    const invocation =
      typeof o.invocation === "string" && VALID_INVOCATIONS.has(o.invocation)
        ? o.invocation
        : "user";
    const confidence =
      typeof o.confidence === "string" && VALID_CONFIDENCES.has(o.confidence)
        ? o.confidence
        : "medium";

    valid.push({
      insight: o.insight,
      typeGuess: o.typeGuess as Observation["typeGuess"],
      invocation: invocation as Observation["invocation"],
      confidence: confidence as Observation["confidence"],
      project,
      evidence: o.evidence.filter((e): e is string => typeof e === "string"),
    });
  }

  return valid;
}

/** Validates that every entry has the required fields with correct types and values. */
function validateEntries(raw: unknown[]): AgentEntry[] | null {
  if (raw.length === 0) return [];

  const validated: AgentEntry[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const e = item as Record<string, unknown>;

    if (typeof e.type !== "string" || !VALID_TYPES.has(e.type)) return null;
    if (typeof e.scope !== "string" || !VALID_SCOPES.has(e.scope)) return null;
    if (typeof e.action !== "string" || !VALID_ACTIONS.has(e.action)) return null;
    if (typeof e.path !== "string" || e.path.length === 0) return null;
    if (typeof e.content !== "string" || e.content.length === 0) return null;
    if (typeof e.sourcePattern !== "string") return null;

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
