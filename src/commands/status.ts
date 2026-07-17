import { readConfig, readState, readLedger, intervalToMs } from "../store.js";
import { isScheduleInstalled } from "../scheduler.js";
import { resolveAgentCli } from "../agent.js";
import { c } from "../ui.js";

/** Prints config, schedule, last run, watermark count, and CLI availability. */
export async function statusCommand(): Promise<void> {
  const config = await readConfig();

  if (!config) {
    console.log(c.warn("cursor-distill is not initialized. Run: cursor-distill init"));
    return;
  }

  console.log(`\n${c.bold("cursor-distill status")}\n${"─".repeat(40)}\n`);

  console.log(`Interval:         ${c.info(config.interval)}`);
  console.log(`Extract model:    ${c.info(config.extractModel)}`);
  console.log(`Synthesize model: ${c.info(config.synthesizeModel)}`);
  console.log(`Initialized:      ${c.dim(config.createdAt ?? "unknown")}`);

  if (config.includeProjects?.length || config.ignoreProjects?.length) {
    if (config.includeProjects?.length) {
      console.log(`Include projects: ${c.info(config.includeProjects.join(", "))}`);
    }
    if (config.ignoreProjects?.length) {
      console.log(`Ignore projects:  ${c.warn(config.ignoreProjects.join(", "))}`);
    }
  } else {
    console.log(`Project filter:   ${c.dim("all projects")}`);
  }

  const scheduled = isScheduleInstalled();
  console.log(`\nCron schedule: ${scheduled ? c.success("installed") : c.error("NOT installed")}`);

  const state = await readState();
  if (state.lastRunAt) {
    console.log(`Last run:      ${c.dim(state.lastRunAt)}`);
    const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
    const nextIn = Math.max(0, intervalToMs(config.interval) - elapsed);
    if (nextIn > 0) {
      console.log(`Next run in:   ~${Math.ceil(nextIn / 3_600_000)}h`);
    } else {
      console.log(`Next run:      ${c.success("due (will fire on next hourly tick)")}`);
    }
  } else {
    console.log(`Last run:      ${c.dim("never")}`);
  }

  console.log(`\nProjects tracked:  ${c.bold(String(Object.keys(state.projects).length))}`);
  console.log(`Artifacts created: ${c.bold(String((await readLedger()).length))}`);

  const agentOk = resolveAgentCli() !== null;
  console.log(`\nCursor CLI: ${agentOk ? c.success("found") : c.error("NOT FOUND")}`);
  if (!agentOk) {
    console.log(c.dim("  Install: curl https://cursor.com/install -fsS | bash"));
  }
}
