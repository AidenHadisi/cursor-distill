import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const MARKER = "# cursor-distill";

/** Adds (or replaces) the hourly cron entry that triggers `cursor-distill run`. */
export function installSchedule(): { installed: boolean; line: string } {
  const cronLine = buildCronLine();
  const withoutOurs = stripMarkerLines(getCrontab());
  const trimmed = withoutOurs.trimEnd();
  const newCrontab =
    trimmed.length > 0 ? `${trimmed}\n${cronLine}\n` : `${cronLine}\n`;

  setCrontab(newCrontab);
  return { installed: true, line: cronLine };
}

/** Removes the cursor-distill cron entry. Returns false if none was found. */
export function removeSchedule(): boolean {
  const existing = getCrontab();
  if (!existing.includes(MARKER)) return false;

  setCrontab(stripMarkerLines(existing));
  return true;
}

/** Checks whether the cron entry is currently registered. */
export function isScheduleInstalled(): boolean {
  return getCrontab().includes(MARKER);
}

function stripMarkerLines(crontab: string): string {
  return crontab
    .split("\n")
    .filter((line) => !line.includes(MARKER))
    .join("\n");
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildCronLine(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(currentDir, "cli.js");
  const logPath = join(homedir(), ".cursor-distill", "cron.log");
  return `0 * * * * ${shellQuote(process.execPath)} ${shellQuote(cliPath)} run >> ${shellQuote(logPath)} 2>&1 ${MARKER}`;
}
