import { createHash } from "node:crypto";
import {
  ensureDataDir,
  readConfig,
  writeConfig,
  readPromptFile,
  writePromptFile,
  intervalToMs,
  type Config,
  type PromptName,
} from "../store.js";
import {
  DEFAULT_EXTRACT_PROMPT,
  DEFAULT_SYNTHESIZE_PROMPT,
} from "../defaultPrompts.js";
import { installSchedule } from "../scheduler.js";
import { resolveAgentCli } from "../agent.js";
import { c, sym } from "../ui.js";

/** Sets up ~/.cursor-distill/, writes the default prompts, and registers the cron schedule. */
export async function initCommand(opts: {
  interval: string;
  extractModel: string;
  synthesizeModel: string;
  include: string[];
  ignore: string[];
}): Promise<void> {
  try {
    intervalToMs(opts.interval);
  } catch (err) {
    console.error(c.error(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  const agentPath = resolveAgentCli();
  if (!agentPath) {
    console.error(
      c.error("Error: Cursor CLI (agent) not found on PATH.") + "\n\n" +
        "Install it:\n" +
        c.dim("  macOS/Linux/WSL: curl https://cursor.com/install -fsS | bash") + "\n",
    );
    process.exit(1);
  }
  console.log(`  ${sym.check} Cursor CLI found at ${c.dim(agentPath)}`);

  await ensureDataDir();
  await syncPrompt("extract", DEFAULT_EXTRACT_PROMPT);
  await syncPrompt("synthesize", DEFAULT_SYNTHESIZE_PROMPT);

  const existing = await readConfig();

  const includeProjects = opts.include.length > 0 ? opts.include : existing?.includeProjects;
  const ignoreProjects = opts.ignore.length > 0 ? opts.ignore : existing?.ignoreProjects;

  const config: Config = {
    interval: opts.interval,
    extractModel: opts.extractModel,
    synthesizeModel: opts.synthesizeModel,
    agentPath,
    ...(includeProjects?.length ? { includeProjects } : {}),
    ...(ignoreProjects?.length ? { ignoreProjects } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await writeConfig(config);
  console.log(
    `  ${sym.check} Config saved ${c.dim(`(interval: ${opts.interval}, extract: ${opts.extractModel}, synthesize: ${opts.synthesizeModel})`)}`,
  );
  if (includeProjects?.length) {
    console.log(`  ${sym.bullet} Include projects: ${c.info(includeProjects.join(", "))}`);
  }
  if (ignoreProjects?.length) {
    console.log(`  ${sym.bullet} Ignore projects: ${c.warn(ignoreProjects.join(", "))}`);
  }

  try {
    const { line } = installSchedule();
    console.log(`  ${sym.check} Cron schedule installed: ${c.dim(line)}`);
  } catch (err) {
    console.error(
      `  ${sym.cross} ${c.warn(`Could not install cron schedule: ${(err as Error).message}`)}`,
    );
    console.error(c.dim("  You can still run manually: cursor-distill run --now"));
  }

  console.log(
    `\n${c.success("cursor-distill initialized.")} It will check hourly and run every ${c.bold(opts.interval)}.`,
  );
  console.log(c.dim("Edit the prompts at ~/.cursor-distill/prompts/"));
  console.log(c.dim("View status: cursor-distill status"));
  console.log(c.dim("Run now: cursor-distill run --now"));
}

/** Writes the default prompt if missing; leaves customized prompts alone. */
async function syncPrompt(
  name: PromptName,
  defaultContent: string,
): Promise<void> {
  const existing = await readPromptFile(name);

  if (!existing) {
    await writePromptFile(name, defaultContent);
    console.log(`  ${sym.check} Default prompt written to ${c.dim(`~/.cursor-distill/prompts/${name}.md`)}`);
    return;
  }

  const unchanged =
    createHash("sha256").update(existing).digest("hex") ===
    createHash("sha256").update(defaultContent).digest("hex");
  if (!unchanged) {
    console.log(`  ${sym.bullet} Custom ${c.info(`prompts/${name}.md`)} preserved`);
  }
}
