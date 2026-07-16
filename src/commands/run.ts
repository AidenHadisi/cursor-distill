import { writeFile, mkdir } from "node:fs/promises";
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
  type LedgerEntry,
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

  if (!opts.now && !(await isIntervalElapsed(config.interval))) {
    process.exit(0);
  }

  console.log("Extracting transcripts...");
  const state = await readState();
  const result = await extractTranscripts(state);

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
  const observations = await runExtraction(chunks, config.extractModel, runDir);
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
  );

  if (!synthesis.success) {
    console.error(`Synthesis failed: ${synthesis.error}`);
    console.error(`Logs: ~/.cursor-distill/runs/${runId}/`);
    process.exit(1);
  }

  if (synthesis.entries.length > 0) {
    const written = await writeArtifacts(synthesis.entries);
    await appendLedger(toLedgerEntries(written, runId));
  }

  await writeState({
    projects: result.newWatermarks,
    lastRunAt: new Date().toISOString(),
  });

  console.log(`\nRun ${runId} complete.`);
  if (synthesis.entries.length === 0) {
    console.log("No new artifacts created.");
  } else {
    console.log(`Wrote ${synthesis.entries.length} artifact(s):`);
    for (const e of synthesis.entries) {
      console.log(`  ${e.action} ${e.type} (${e.scope}): ${e.path}`);
    }
  }
  console.log(`Logs: ~/.cursor-distill/runs/${runId}/`);
}

/** Returns true if enough time has passed since the last successful run. */
async function isIntervalElapsed(interval: string): Promise<boolean> {
  const state = await readState();
  if (!state.lastRunAt) return true;
  const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
  return elapsed >= intervalToMs(interval);
}

/** Expands ~ to the user's home directory. */
function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/** Writes each artifact's content to disk, creating directories as needed. */
async function writeArtifacts(entries: AgentEntry[]): Promise<AgentEntry[]> {
  const written: AgentEntry[] = [];

  for (const entry of entries) {
    const fullPath = expandHome(entry.path);
    try {
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
    path: e.path,
    action: e.action,
    sourcePattern: e.sourcePattern,
  }));
}
