import { writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readConfig,
  readState,
  writeState,
  appendLedger,
  intervalToMs,
  dataDir,
  acquireRunLock,
  releaseRunLock,
  type Config,
  type LedgerEntry,
  type WatermarkState,
} from "../store.js";
import { extractTranscripts, buildChunks } from "../extract.js";
import { runExtraction, runSynthesis, type AgentEntry } from "../agent.js";

/**
 * The main pipeline: extract transcripts, chunk them per project, run the
 * extraction model over each chunk in parallel, synthesize artifacts with
 * the smart model, validate, write files, and record results.
 * Exits silently when the configured interval hasn't elapsed yet (unless --now).
 */
export async function runCommand(opts: { now?: boolean }): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.error(
      "Error: cursor-distill not initialized. Run: cursor-distill init",
    );
    process.exit(1);
  }

  const state = await readState();
  if (!opts.now && state.lastRunAt) {
    const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
    if (elapsed < intervalToMs(config.interval)) {
      process.exit(0);
    }
  }

  if (!(await acquireRunLock())) {
    console.log("Another cursor-distill run is already active. Exiting.");
    process.exit(0);
  }

  try {
    await runPipeline(config, state);
  } finally {
    await releaseRunLock();
  }
}

async function runPipeline(config: Config, state: WatermarkState): Promise<void> {
  console.log("Extracting transcripts...");
  const result = await extractTranscripts(state, config);

  if (result.messages.length === 0) {
    console.log("No new transcripts since last run.");
    await writeState({ ...state, lastRunAt: new Date().toISOString() });
    return;
  }

  const chunks = buildChunks(result);
  console.log(
    `Found ${result.messages.length} user messages -> ${chunks.length} chunk(s) across ${Object.keys(result.projectCounts).length} projects.`,
  );

  const runId = randomUUID().slice(0, 8);
  const runDir = join(dataDir(), "runs", runId);
  await mkdir(runDir, { recursive: true });

  console.log(`\nStage 1: extracting patterns (${config.extractModel})...`);
  const observations = await runExtraction(chunks, config.extractModel, runDir, config.agentPath);
  console.log(`Extraction complete: ${observations.length} observation(s).`);

  if (observations.length === 0) {
    await writeState({
      projects: result.newWatermarks,
      lastRunAt: new Date().toISOString(),
    });
    console.log(`\nRun ${runId} complete. No patterns found.`);
    return;
  }

  console.log(`\nStage 2: synthesizing artifacts (${config.synthesizeModel})...`);
  const synthesis = await runSynthesis(
    observations,
    config.synthesizeModel,
    runDir,
    config.agentPath,
  );

  if (!synthesis.success) {
    console.error(`Synthesis failed: ${synthesis.error}`);
    console.error(`Logs: ~/.cursor-distill/runs/${runId}/`);
    // Advance lastRunAt so failed runs don't retry every hourly cron tick.
    await writeState({ ...state, lastRunAt: new Date().toISOString() });
    // Set exitCode and return so runCommand's finally can release the lock.
    process.exitCode = 1;
    return;
  }

  const written = synthesis.entries.length > 0
    ? await writeArtifacts(synthesis.entries, runDir)
    : [];
  if (written.length > 0) {
    await appendLedger(toLedgerEntries(written, runId));
  }

  await writeState({
    projects: result.newWatermarks,
    lastRunAt: new Date().toISOString(),
  });

  console.log(`\nRun ${runId} complete.`);
  if (written.length === 0) {
    console.log("No new artifacts created.");
  } else {
    console.log(`Wrote ${written.length} artifact(s):`);
    for (const e of written) {
      console.log(`  ${e.action} ${e.type} (${e.scope}): ${e.path}`);
    }
  }
  console.log(`Logs: ~/.cursor-distill/runs/${runId}/`);
}

/** Expands ~ to the user's home directory and resolves. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

const ALLOWED_SUBDIRS = ["rules", "skills", "agents"] as const;
const DOT_CURSOR = "/.cursor/";

/** True when `rel` is exactly an allowed subdir or a path beneath one. */
function isAllowedCursorRel(rel: string): boolean {
  return ALLOWED_SUBDIRS.some((sub) => rel === sub || rel.startsWith(`${sub}/`));
}

/**
 * Validates that an artifact path is inside an allowed `.cursor/` subtree and
 * passes action-specific existence checks.
 * Returns `{ fullPath }` on success or `{ rejected }` with a reason.
 */
export function validateArtifactPath(
  entry: AgentEntry,
): { fullPath: string } | { rejected: string } {
  // Reject before resolve() so ".." cannot be normalised away.
  if (entry.path.includes("..")) {
    return { rejected: "path traversal detected" };
  }

  const fullPath = expandHome(entry.path);
  const cursorIdx = fullPath.lastIndexOf(DOT_CURSOR);
  if (cursorIdx === -1) {
    return {
      rejected: entry.scope === "project"
        ? "project-scoped path missing /.cursor/ segment"
        : "path is outside allowed .cursor/{rules,skills,agents}/ trees",
    };
  }

  const afterCursor = fullPath.slice(cursorIdx + DOT_CURSOR.length);
  if (!isAllowedCursorRel(afterCursor)) {
    return { rejected: "path is outside allowed .cursor/{rules,skills,agents}/ trees" };
  }
  if (!afterCursor.includes("/") && !afterCursor.includes(".")) {
    return { rejected: "path points to a directory, not a file" };
  }

  if (entry.scope === "global") {
    const globalPrefix = join(homedir(), ".cursor") + "/";
    if (!fullPath.startsWith(globalPrefix)) {
      return { rejected: "path is outside allowed .cursor/{rules,skills,agents}/ trees" };
    }
  } else {
    const projectRoot = fullPath.slice(0, cursorIdx);
    if (!existsSync(projectRoot)) {
      return { rejected: `project root does not exist: ${projectRoot}` };
    }
  }

  if (entry.action === "created" && existsSync(fullPath)) {
    return { rejected: "file already exists (refusing action:created overwrite)" };
  }
  if (entry.action === "edited" && !existsSync(fullPath)) {
    return { rejected: "file does not exist (cannot edit a nonexistent artifact)" };
  }

  return { fullPath };
}

/** Writes each artifact's content to disk after sandbox validation. */
async function writeArtifacts(entries: AgentEntry[], runDir: string): Promise<AgentEntry[]> {
  const written: AgentEntry[] = [];

  for (const entry of entries) {
    const check = validateArtifactPath(entry);
    if ("rejected" in check) {
      console.warn(`  Skipped ${entry.path}: ${check.rejected}`);
      continue;
    }
    const { fullPath } = check;

    try {
      if (entry.action === "edited") {
        const backupDir = join(runDir, "backups");
        await mkdir(backupDir, { recursive: true });
        const safeName = entry.path.replace(/[/\\]/g, "_");
        await copyFile(fullPath, join(backupDir, safeName));
      }

      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, entry.content);
      written.push(entry);
      console.log(`  Wrote: ${entry.path}`);
    } catch (err) {
      console.error(`  Failed to write ${entry.path}: ${(err as Error).message}`);
    }
  }

  return written;
}

/** Strips content from entries and converts to ledger format. */
function toLedgerEntries(entries: AgentEntry[], runId: string): LedgerEntry[] {
  return entries.map((e) => ({
    runId,
    date: new Date().toISOString(),
    type: e.type,
    scope: e.scope,
    project: e.scope === "project" ? inferProject(e.path) : undefined,
    path: e.path,
    action: e.action,
    sourcePattern: e.sourcePattern,
  }));
}

/** Extracts a project directory from an artifact path like ~/projects/myapp/.cursor/... */
function inferProject(artifactPath: string): string | undefined {
  const expanded = expandHome(artifactPath);
  const idx = expanded.lastIndexOf(DOT_CURSOR);
  if (idx === -1) return undefined;
  return expanded.slice(0, idx);
}
