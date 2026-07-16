import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
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

const AGENT_CANDIDATES = ["agent", "cursor-agent"];

/** Sets up ~/.cursor-distill/, writes the default prompts, and registers the cron schedule. */
export async function initCommand(opts: {
  interval: string;
  extractModel: string;
  synthesizeModel: string;
}): Promise<void> {
  try {
    intervalToMs(opts.interval);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const agentPath = findAgentCli();
  if (!agentPath) {
    console.error(
      "Error: Cursor CLI (agent) not found on PATH.\n\n" +
        "Install it:\n" +
        "  macOS/Linux/WSL: curl https://cursor.com/install -fsS | bash\n",
    );
    process.exit(1);
  }
  console.log(`  Cursor CLI found at ${agentPath}`);

  await ensureDataDir();
  await syncPrompt("extract", DEFAULT_EXTRACT_PROMPT);
  await syncPrompt("synthesize", DEFAULT_SYNTHESIZE_PROMPT);

  const existing = await readConfig();
  const config: Config = {
    interval: opts.interval,
    extractModel: opts.extractModel,
    synthesizeModel: opts.synthesizeModel,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await writeConfig(config);
  console.log(
    `  Config saved (interval: ${opts.interval}, extract: ${opts.extractModel}, synthesize: ${opts.synthesizeModel})`,
  );

  try {
    const { line } = installSchedule();
    console.log(`  Cron schedule installed: ${line}`);
  } catch (err) {
    console.error(
      `  Warning: Could not install cron schedule: ${(err as Error).message}`,
    );
    console.error("  You can still run manually: cursor-distill run --now");
  }

  console.log(
    "\ncursor-distill initialized. It will check hourly and run every " +
      opts.interval +
      ".",
  );
  console.log("Edit the prompts at ~/.cursor-distill/prompts/");
  console.log("View status: cursor-distill status");
  console.log("Run now: cursor-distill run --now");
}

/** Returns the path to the first Cursor CLI binary found on PATH, or null. */
function findAgentCli(): string | null {
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
 * Writes the default prompt on first run. On subsequent runs it only
 * overwrites if the user hasn't customized the file.
 */
async function syncPrompt(
  name: PromptName,
  defaultContent: string,
): Promise<void> {
  const existing = await readPromptFile(name);

  if (!existing) {
    await writePromptFile(name, defaultContent);
    console.log(
      `  Default prompt written to ~/.cursor-distill/prompts/${name}.md`,
    );
    return;
  }

  const existingHash = createHash("sha256").update(existing).digest("hex");
  const defaultHash = createHash("sha256").update(defaultContent).digest("hex");
  if (existingHash === defaultHash) {
    await writePromptFile(name, defaultContent);
  } else {
    console.log(
      `  Custom prompts/${name}.md preserved (edit to customize)`,
    );
  }
}
