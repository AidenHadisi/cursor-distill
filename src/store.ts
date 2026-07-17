import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
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
  agentPath?: string;
  includeProjects?: string[];
  ignoreProjects?: string[];
  createdAt: string;
}

/** Include/ignore patterns used when scanning project transcript dirs. */
export type ProjectFilter = Pick<Config, "includeProjects" | "ignoreProjects">;

/**
 * Returns true if a project slug passes the include/ignore filters.
 * Patterns support `*` wildcards (converted to regex `.*`).
 * Empty/missing includeProjects means all projects are eligible;
 * ignoreProjects always wins over includeProjects.
 */
export function matchesProjectFilter(slug: string, filter: ProjectFilter): boolean {
  if (filter.ignoreProjects?.some((p) => wildcardMatch(slug, p))) return false;
  if (!filter.includeProjects?.length) return true;
  return filter.includeProjects.some((p) => wildcardMatch(slug, p));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
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
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    const ts = Date.now();
    const corrupt = `${path}.corrupt-${ts}`;
    try {
      await rename(path, corrupt);
    } catch {
      // Best effort; the file may have vanished.
    }
    console.warn(`Warning: corrupt JSON at ${path} — backed up to ${corrupt}, using defaults`);
    return fallback;
  }
}

/** Atomic write: writes to a temp file then renames over the target. */
async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDataDir();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}

const LOCK_PATH = join(DATA_DIR, "run.lock");

/** Creates the lock file with O_EXCL. Returns false on EEXIST; rethrows other errors. */
async function tryCreateLock(): Promise<boolean> {
  try {
    await writeFile(LOCK_PATH, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Acquires an exclusive run lock using a PID file created with O_EXCL.
 * Returns true if the lock was acquired, false if another live run holds it.
 * Steals the lock when the previous holder is dead (stale PID file).
 */
export async function acquireRunLock(): Promise<boolean> {
  if (await tryCreateLock()) return true;

  // Lock exists — steal it only if the holder PID is dead or unreadable.
  try {
    const pid = parseInt((await readFile(LOCK_PATH, "utf-8")).trim(), 10);
    if (!Number.isNaN(pid)) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        // Process is gone — stale lock.
      }
    }
  } catch {
    // Lock vanished between EEXIST and read.
  }

  try {
    await unlink(LOCK_PATH);
  } catch {
    // Another process may have already removed it.
  }
  return tryCreateLock();
}

/** Releases the run lock only if this process owns it. */
export async function releaseRunLock(): Promise<void> {
  try {
    const pid = parseInt((await readFile(LOCK_PATH, "utf-8")).trim(), 10);
    if (pid !== process.pid) return;
    await unlink(LOCK_PATH);
  } catch {
    // Already removed or never held.
  }
}
