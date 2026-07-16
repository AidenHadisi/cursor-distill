import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  ensureDataDir,
  readConfig,
  writeConfig,
  readPrompt,
  writePrompt,
  intervalToMs,
  type Config,
} from "../store.js";
import { DEFAULT_PROMPT } from "../defaultPrompt.js";
import { installSchedule } from "../scheduler.js";

const AGENT_CANDIDATES = ["agent", "cursor-agent"];

/** Sets up ~/.cursor-distill/, writes the default prompt, and registers the cron schedule. */
export async function initCommand(opts: {
  interval: string;
  model?: string;
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
  await syncPrompt();

  const existing = await readConfig();
  const config: Config = {
    interval: opts.interval,
    model: opts.model ?? existing?.model,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    promptHash: createHash("sha256").update(DEFAULT_PROMPT).digest("hex"),
  };
  await writeConfig(config);
  console.log(
    `  Config saved (interval: ${opts.interval}, model: ${opts.model ?? "default"})`,
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
  console.log("Edit the rubric prompt at ~/.cursor-distill/prompt.md");
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
async function syncPrompt(): Promise<void> {
  const existingPrompt = await readPrompt();
  const defaultHash = createHash("sha256")
    .update(DEFAULT_PROMPT)
    .digest("hex");

  if (!existingPrompt) {
    await writePrompt(DEFAULT_PROMPT);
    console.log("  Default prompt written to ~/.cursor-distill/prompt.md");
    return;
  }

  const existingHash = createHash("sha256")
    .update(existingPrompt)
    .digest("hex");
  if (existingHash === defaultHash) {
    await writePrompt(DEFAULT_PROMPT);
  } else {
    console.log(
      "  Custom prompt.md preserved (edit ~/.cursor-distill/prompt.md to customize)",
    );
  }
}
