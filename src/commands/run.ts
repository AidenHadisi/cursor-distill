import {
  readConfig,
  readState,
  writeState,
  appendLedger,
  intervalToMs,
} from "../store.js";
import { extractTranscripts, buildDigest } from "../extract.js";
import { invokeAgent } from "../agent.js";

/**
 * The main pipeline: extract transcripts, build a digest, invoke the
 * headless agent, and record results. Exits silently when the configured
 * interval hasn't elapsed yet (unless --now is set).
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

  console.log(
    `Found ${result.messages.length} user messages across ${Object.keys(result.projectCounts).length} projects.`,
  );

  const digest = buildDigest(result);
  console.log(
    `Digest: ${digest.totalMessages} deduplicated messages (${digest.digest.length} chars).`,
  );

  console.log("Invoking headless agent...");
  const runResult = await invokeAgent(digest, config.model);

  if (!runResult.success) {
    console.error(`Agent run failed: ${runResult.error}`);
    console.error(
      `Log: ~/.cursor-distill/runs/${runResult.runId}/agent.log`,
    );
    process.exit(1);
  }

  if (runResult.entries.length > 0) {
    await appendLedger(runResult.entries);
  }

  await writeState({
    projects: digest.newWatermarks,
    lastRunAt: new Date().toISOString(),
  });

  console.log(`\nRun ${runResult.runId} complete.`);
  if (runResult.entries.length === 0) {
    console.log("No new artifacts created.");
  } else {
    console.log(`Created/edited ${runResult.entries.length} artifact(s):`);
    for (const e of runResult.entries) {
      console.log(`  ${e.action} ${e.type} (${e.scope}): ${e.path}`);
    }
  }
  console.log(`Log: ~/.cursor-distill/runs/${runResult.runId}/`);
}

/** Returns true if enough time has passed since the last successful run. */
async function isIntervalElapsed(interval: string): Promise<boolean> {
  const state = await readState();
  if (!state.lastRunAt) return true;
  const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
  return elapsed >= intervalToMs(interval);
}
