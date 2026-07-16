import { spawn, execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readPrompt, readLedger, dataDir, type LedgerEntry } from "./store.js";
import { DEFAULT_PROMPT } from "./defaultPrompt.js";
import type { DigestOutput } from "./extract.js";

const AGENT_CANDIDATES = ["agent", "cursor-agent"];

const VALID_TYPES = new Set(["rule", "skill", "subagent"]);
const VALID_SCOPES = new Set(["global", "project"]);
const VALID_ACTIONS = new Set(["created", "edited"]);

/** A single artifact proposed by the agent, including file content. */
export interface AgentEntry {
  type: "rule" | "skill" | "subagent";
  scope: "global" | "project";
  path: string;
  action: "created" | "edited";
  content: string;
  sourcePattern: string;
}

/** Outcome of a single headless agent invocation. */
export interface RunResult {
  runId: string;
  entries: AgentEntry[];
  agentLog: string;
  success: boolean;
  error?: string;
}

/**
 * Spawns the Cursor CLI headlessly with the digest and rubric prompt.
 * The agent returns structured JSON to stdout — it does NOT write any files.
 * We parse, validate, and return the entries for the caller to write.
 */
export async function invokeAgent(
  digest: DigestOutput,
  model?: string,
): Promise<RunResult> {
  const runId = randomUUID().slice(0, 8);
  const runDir = join(dataDir(), "runs", runId);
  await mkdir(runDir, { recursive: true });

  const fullPrompt = await buildPrompt(digest);
  await writeFile(join(runDir, "prompt.txt"), fullPrompt);

  const agentCmd = findAgent();
  const args = ["-p", fullPrompt, "--force"];
  if (model) {
    args.push("--model", model);
  }

  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(agentCmd, args, {
      cwd: homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", async (code) => {
      const agentLog = `EXIT CODE: ${code}\n\n--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`;
      await writeFile(join(runDir, "agent.log"), agentLog);

      if (code !== 0) {
        resolve({
          runId,
          entries: [],
          agentLog,
          success: false,
          error: `Agent exited with code ${code}`,
        });
        return;
      }

      const parsed = extractJson(stdout);
      if (parsed === null) {
        resolve({
          runId,
          entries: [],
          agentLog,
          success: false,
          error: "No valid JSON array found in agent stdout",
        });
        return;
      }

      const validated = validateEntries(parsed);
      if (validated === null) {
        resolve({
          runId,
          entries: [],
          agentLog,
          success: false,
          error: "Agent returned entries with missing or invalid fields",
        });
        return;
      }

      await writeFile(join(runDir, "response.json"), JSON.stringify(validated, null, 2));
      resolve({ runId, entries: validated, agentLog, success: true });
    });

    proc.on("error", async (err) => {
      const agentLog = `SPAWN ERROR: ${err.message}`;
      await writeFile(join(runDir, "agent.log"), agentLog);
      resolve({
        runId,
        entries: [],
        agentLog,
        success: false,
        error: err.message,
      });
    });
  });
}

/** Resolves the first available Cursor CLI binary on PATH. */
function findAgent(): string {
  for (const cmd of AGENT_CANDIDATES) {
    try {
      execSync(`command -v ${cmd}`, { stdio: "ignore" });
      return cmd;
    } catch {
      // continue
    }
  }
  return "agent";
}

/** Assembles the full prompt: user rubric + hardcoded mechanics + digest. */
async function buildPrompt(digest: DigestOutput): Promise<string> {
  const userPrompt = (await readPrompt()) ?? DEFAULT_PROMPT;
  const ledger = await readLedger();

  const mechanics = `
---
## System Instructions (non-negotiable)

**Do NOT write any files to disk.** Instead, return your entire response as a single JSON array printed to stdout.

Each element in the array represents one artifact to create or edit:

\`\`\`json
[
  {
    "type": "rule",
    "scope": "global",
    "path": "~/.cursor/rules/example.mdc",
    "action": "created",
    "content": "---\\nalwaysApply: true\\n---\\n# Example\\n\\nConcise instruction.",
    "sourcePattern": "User repeatedly asked for camelCase JSON"
  }
]
\`\`\`

Required fields:
- **type**: one of "rule", "skill", "subagent"
- **scope**: one of "global", "project"
- **path**: full file path (use ~ for home directory)
- **action**: "created" or "edited"
- **content**: the complete file contents to write
- **sourcePattern**: short description of the repeated behavior that triggered this

If nothing warrants creation, return an empty array: \`[]\`

**Do not write any files yourself. Do not create directories. Only output the JSON array.**

Previously created artifacts (check before duplicating):
${JSON.stringify(ledger.map((e) => ({ type: e.type, scope: e.scope, path: e.path })), null, 2)}
`;

  const projectSummary = Object.entries(digest.projectCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([p, c]) => `- ${p}: ${c}`)
    .join("\n");

  return `${userPrompt}

${mechanics}

---
# User Message Digest

Summary: ${digest.totalMessages} deduplicated messages across ${Object.keys(digest.projectCounts).length} projects.

Project message counts:
${projectSummary}

${digest.digest}
`;
}

/**
 * Extracts the first valid JSON array from the agent's stdout.
 * Handles cases where the agent wraps JSON in markdown code fences or adds prose.
 */
function extractJson(stdout: string): unknown[] | null {
  // Try the whole string first
  try {
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // continue
  }

  // Look for a JSON array in markdown code fences
  const fenceMatch = stdout.match(/```(?:json)?\s*\n(\[[\s\S]*?\])\s*\n```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  // Look for the first [ ... ] block
  const bracketStart = stdout.indexOf("[");
  const bracketEnd = stdout.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    try {
      const parsed = JSON.parse(stdout.slice(bracketStart, bracketEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  return null;
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
