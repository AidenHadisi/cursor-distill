import { execSync } from "node:child_process";
import { resolve } from "node:path";

const MARKER = "# cursor-distill";

/** Adds (or replaces) the hourly cron entry that triggers `cursor-distill run`. */
export function installSchedule(): { installed: boolean; line: string } {
  const cronLine = buildCronLine();
  let existing = getCrontab();

  if (existing.includes(MARKER)) {
    existing = existing
      .split("\n")
      .filter((l) => !l.includes(MARKER))
      .join("\n");
  }

  const trimmed = existing.trimEnd();
  const newCrontab =
    trimmed.length > 0 ? `${trimmed}\n${cronLine}\n` : `${cronLine}\n`;

  setCrontab(newCrontab);
  return { installed: true, line: cronLine };
}

/** Removes the cursor-distill cron entry. Returns false if none was found. */
export function removeSchedule(): boolean {
  const existing = getCrontab();
  if (!existing.includes(MARKER)) return false;

  const filtered = existing
    .split("\n")
    .filter((l) => !l.includes(MARKER))
    .join("\n");

  setCrontab(filtered);
  return true;
}

/** Checks whether the cron entry is currently registered. */
export function isScheduleInstalled(): boolean {
  return getCrontab().includes(MARKER);
}

function getCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function setCrontab(content: string): void {
  execSync("crontab -", { input: content, encoding: "utf-8" });
}

function buildCronLine(): string {
  const cliPath = resolve(__dirname, "cli.js");
  const nodePath = process.execPath;
  return `0 * * * * ${nodePath} ${cliPath} run ${MARKER}`;
}
