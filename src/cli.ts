#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";

const program = new Command();

program
  .name("cursor-distill")
  .description(
    "Distill your Cursor agent transcripts into rules, skills, and subagents"
  )
  .version("0.1.0");

program
  .command("init")
  .description("Set up cursor-distill with a schedule")
  .option("--interval <duration>", "run interval (e.g. 7d, 3d, 1d)", "7d")
  .option("--model <slug>", "model to use for the headless agent", "claude-opus-4-8-thinking")
  .action(initCommand);

program
  .command("run")
  .description("Run the distillation pipeline")
  .option("--now", "ignore interval guard, run immediately")
  .action(runCommand);

program
  .command("stats")
  .description("Show artifacts created by cursor-distill")
  .option("--json", "output as JSON")
  .action(statsCommand);

program
  .command("status")
  .description("Show schedule, last run, and auth status")
  .action(statusCommand);

program
  .command("uninstall")
  .description("Remove the cron schedule")
  .option("--purge", "also delete ~/.cursor-distill/")
  .action(uninstallCommand);

program.parse();
