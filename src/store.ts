import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".cursor-distill");

const INTERVAL_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

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
  return readJson<Config | null>(join(DATA_DIR, "config.json"), null);
}

export async function writeConfig(config: Config): Promise<void> {
  await writeJson(join(DATA_DIR, "config.json"), config);
}

export async function readState(): Promise<WatermarkState> {
  return readJson(join(DATA_DIR, "state.json"), { projects: {} });
}

export async function writeState(state: WatermarkState): Promise<void> {
  await writeJson(join(DATA_DIR, "state.json"), state);
}

export async function readLedger(): Promise<LedgerEntry[]> {
  return readJson(join(DATA_DIR, "ledger.json"), []);
}

/** Appends new entries to the ledger, preserving all existing ones. */
export async function appendLedger(entries: LedgerEntry[]): Promise<void> {
  const existing = await readLedger();
  existing.push(...entries);
  await writeJson(join(DATA_DIR, "ledger.json"), existing);
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
  const unitMs = INTERVAL_MS[match[2]];
  if (unitMs === undefined) {
    throw new Error(`Unknown unit: ${match[2]}`);
  }
  return parseInt(match[1], 10) * unitMs;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDataDir();
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}
