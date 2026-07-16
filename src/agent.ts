import { spawn, execSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readPrompt, readLedger, dataDir, type LedgerEntry } from "./store.js";
import { DEFAULT_PROMPT } from "./defaultPrompt.js";
import type { DigestOutput } from "./extract.js";

const AGENT_CANDIDATES = ["agent", "cursor-agent"];

/** Outcome of a single headless agent invocation. */
export interface RunResult {
  runId: string;
  entries: LedgerEntry[];
  agentLog: string;
  success: boolean;
  error?: string;
}

/**
 * Spawns the Cursor CLI headlessly with the digest and rubric prompt.
 * Returns the parsed manifest entries on success, or an error on failure.
 * All run artifacts (prompt, log, manifest) are persisted under runs/<runId>/.
 */
export async function invokeAgent(
  digest: DigestOutput,
  model?: string,
): Promise<RunResult> {
  const runId = randomUUID().slice(0, 8);
  const runDir = join(dataDir(), "runs", runId);
  await mkdir(runDir, { recursive: true });

  const manifestPath = join(runDir, "manifest.json");
  const fullPrompt = await buildPrompt(digest, manifestPath);
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

      const entries = await parseManifest(manifestPath, runId);
      if (entries === null) {
        resolve({
          runId,
          entries: [],
          agentLog,
          success: false,
          error: "Failed to parse manifest.json",
        });
        return;
      }

      resolve({ runId, entries, agentLog, success: true });
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

/** Assembles the full prompt: user rubric + mechanics + digest. */
async function buildPrompt(
  digest: DigestOutput,
  manifestPath: string,
): Promise<string> {
  const userPrompt = (await readPrompt()) ?? DEFAULT_PROMPT;
  const ledger = await readLedger();

  const mechanics = `
---
## Mechanics (non-negotiable, appended by cursor-distill)

1. Check existing artifacts before creating. The current ledger of previously created artifacts:
${JSON.stringify(ledger.map((e) => ({ type: e.type, scope: e.scope, path: e.path })), null, 2)}

2. Write artifacts directly to disk. Do not propose — write the files.

3. When done, write the manifest to: ${manifestPath}
   Format: JSON array of { type, scope, path, action, sourcePattern }

4. If no patterns warrant new artifacts, write an empty array [] to the manifest.
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

/** Reads and validates the manifest the agent was instructed to write. */
async function parseManifest(
  manifestPath: string,
  runId: string,
): Promise<LedgerEntry[] | null> {
  if (!existsSync(manifestPath)) return [];

  try {
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return parsed.map((e: Record<string, string>) => ({
      runId,
      date: new Date().toISOString(),
      type: e.type as LedgerEntry["type"],
      scope: e.scope as LedgerEntry["scope"],
      project: e.project,
      path: e.path,
      action: e.action as LedgerEntry["action"],
      sourcePattern: e.sourcePattern,
    }));
  } catch {
    return null;
  }
}
