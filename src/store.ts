import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".cursor-distill");

export interface Config {
  interval: string;
  extractModel: string;
  synthesizeModel: string;
  createdAt: string;
}

/** The two user-editable prompt files under ~/.cursor-distill/prompts/. */
export type PromptName = "extract" | "synthesize";

/** Per-project watermarks tracking the last processed transcript mtime. */
export interface WatermarkState {
  projects: Record<string, number>;
  lastRunAt?: string;
}

/** A single artifact written by a distillation run. */
export interface LedgerEntry {
  runId: string;
  date: string;
  type: "rule" | "skill" | "subagent";
  scope: "global" | "project";
  project?: string;
  path: string;
  action: "created" | "edited";
  sourcePattern?: string;
}

/** Returns the root data directory (~/.cursor-distill). */
export function dataDir(): string {
  return DATA_DIR;
}

/** Creates the data directory and its subfolders if missing. */
export async function ensureDataDir(): Promise<void> {
  await mkdir(join(DATA_DIR, "runs"), { recursive: true });
  await mkdir(join(DATA_DIR, "prompts"), { recursive: true });
}

export async function readConfig(): Promise<Config | null> {
  const p = join(DATA_DIR, "config.json");
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf-8"));
}

export async function writeConfig(config: Config): Promise<void> {
  await ensureDataDir();
  await writeFile(
    join(DATA_DIR, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}

export async function readState(): Promise<WatermarkState> {
  const p = join(DATA_DIR, "state.json");
  if (!existsSync(p)) return { projects: {} };
  return JSON.parse(await readFile(p, "utf-8"));
}

export async function writeState(state: WatermarkState): Promise<void> {
  await ensureDataDir();
  await writeFile(
    join(DATA_DIR, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export async function readLedger(): Promise<LedgerEntry[]> {
  const p = join(DATA_DIR, "ledger.json");
  if (!existsSync(p)) return [];
  return JSON.parse(await readFile(p, "utf-8"));
}

/** Appends new entries to the ledger, preserving all existing ones. */
export async function appendLedger(entries: LedgerEntry[]): Promise<void> {
  const existing = await readLedger();
  existing.push(...entries);
  await ensureDataDir();
  await writeFile(
    join(DATA_DIR, "ledger.json"),
    JSON.stringify(existing, null, 2) + "\n",
  );
}

/** Reads a user-editable prompt file, or null if it doesn't exist. */
export async function readPromptFile(name: PromptName): Promise<string | null> {
  const p = join(DATA_DIR, "prompts", `${name}.md`);
  if (!existsSync(p)) return null;
  return readFile(p, "utf-8");
}

/** Writes a user-editable prompt file. */
export async function writePromptFile(
  name: PromptName,
  content: string,
): Promise<void> {
  await ensureDataDir();
  await writeFile(join(DATA_DIR, "prompts", `${name}.md`), content);
}

/** Parses a human-friendly interval like "7d", "12h", "30m" into milliseconds. */
export function intervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error(`Invalid interval: ${interval}. Use e.g. 7d, 12h, 30m`);
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "d": return n * 86_400_000;
    case "h": return n * 3_600_000;
    case "m": return n * 60_000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}
