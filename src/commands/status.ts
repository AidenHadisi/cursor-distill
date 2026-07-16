import { readConfig, readState, readLedger, intervalToMs } from "../store.js";
import { isScheduleInstalled } from "../scheduler.js";
import { resolveAgentCli } from "../agent.js";

/** Prints config, schedule, last run, watermark count, and CLI availability. */
export async function statusCommand(): Promise<void> {
  const config = await readConfig();

  if (!config) {
    console.log("cursor-distill is not initialized. Run: cursor-distill init");
    return;
  }

  console.log(`\ncursor-distill status\n${"=".repeat(40)}\n`);

  console.log(`Interval: ${config.interval}`);
  console.log(`Extract model: ${config.extractModel}`);
  console.log(`Synthesize model: ${config.synthesizeModel}`);
  console.log(`Initialized: ${config.createdAt}`);

  const scheduled = isScheduleInstalled();
  console.log(`\nCron schedule: ${scheduled ? "installed" : "NOT installed"}`);

  const state = await readState();
  if (state.lastRunAt) {
    console.log(`Last run: ${state.lastRunAt}`);
    const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
    const nextIn = Math.max(0, intervalToMs(config.interval) - elapsed);
    if (nextIn > 0) {
      console.log(`Next run in: ~${Math.ceil(nextIn / 3_600_000)}h`);
    } else {
      console.log("Next run: due (will fire on next hourly tick)");
    }
  } else {
    console.log("Last run: never");
  }

  console.log(`\nProjects tracked: ${Object.keys(state.projects).length}`);
  console.log(`Artifacts created: ${(await readLedger()).length}`);

  const agentOk = resolveAgentCli() !== null;
  console.log(`\nCursor CLI: ${agentOk ? "found" : "NOT FOUND"}`);
  if (!agentOk) {
    console.log("  Install: curl https://cursor.com/install -fsS | bash");
  }
}
