import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { matchesProjectFilter, type WatermarkState, type ProjectFilter } from "./store.js";

const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor", "projects");

/** Tags injected by Cursor into user messages that carry zero signal. */
const SYSTEM_TAG_PATTERNS = [
  /<system_reminder>[\s\S]*?<\/system_reminder>/g,
  /<attached_files>[\s\S]*?<\/attached_files>/g,
  /<timestamp>[\s\S]*?<\/timestamp>/g,
  /<user_info>[\s\S]*?<\/user_info>/g,
  /<git_status>[\s\S]*?<\/git_status>/g,
  /<rules>[\s\S]*?<\/rules>/g,
  /<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g,
  /<available_subagent_types>[\s\S]*?<\/available_subagent_types>/g,
  /<available_subagent_models>[\s\S]*?<\/available_subagent_models>/g,
  /<agent_skills>[\s\S]*?<\/agent_skills>/g,
  /<mcp_file_system>[\s\S]*?<\/mcp_file_system>/g,
];

/** A single user message extracted from a transcript file. */
export interface ExtractedMessage {
  project: string;
  text: string;
  timestampMs: number;
}

/** Raw extraction result before deduplication. */
export interface DigestResult {
  messages: ExtractedMessage[];
  newWatermarks: Record<string, number>;
  projectCounts: Record<string, number>;
}

/** A batch of deduplicated messages from one project, sized for one extraction call. */
export interface Chunk {
  project: string;
  text: string;
  messageCount: number;
}

interface TranscriptLine {
  role: string;
  message?: {
    content?: Array<{ type: string; text?: string }> | string;
  };
}

/**
 * Walks every project's agent-transcripts/ directory and extracts user
 * messages from JSONL files newer than the stored watermarks.
 */
export async function extractTranscripts(
  watermarks: WatermarkState,
  filter?: ProjectFilter,
): Promise<DigestResult> {
  if (!existsSync(CURSOR_PROJECTS_DIR)) {
    return { messages: [], newWatermarks: {}, projectCounts: {} };
  }

  const projectDirs = await readdir(CURSOR_PROJECTS_DIR, {
    withFileTypes: true,
  });
  const allMessages: ExtractedMessage[] = [];
  const newWatermarks: Record<string, number> = { ...watermarks.projects };
  const projectCounts: Record<string, number> = {};

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const projectSlug = projectDir.name;

    if (filter !== undefined && !matchesProjectFilter(projectSlug, filter)) continue;
    const transcriptsDir = join(
      CURSOR_PROJECTS_DIR,
      projectSlug,
      "agent-transcripts",
    );
    const jsonlFiles = await findJsonlFiles(transcriptsDir);

    const oldWatermark = watermarks.projects[projectSlug] ?? 0;
    let maxMtime = oldWatermark;
    let count = 0;

    for (const filePath of jsonlFiles) {
      const fileStat = await stat(filePath);
      const mtimeMs = fileStat.mtimeMs;

      if (mtimeMs <= oldWatermark) continue;
      if (mtimeMs > maxMtime) maxMtime = mtimeMs;

      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);

        for (const line of lines) {
          try {
            const parsed: TranscriptLine = JSON.parse(line);
            if (parsed.role !== "user") continue;

            const fullText = extractFullText(parsed);
            if (!fullText) continue;

            for (const q of extractUserQueries(fullText)) {
              allMessages.push({
                project: projectSlug,
                text: q,
                timestampMs: mtimeMs,
              });
              count++;
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    if (maxMtime > oldWatermark) {
      newWatermarks[projectSlug] = maxMtime;
    }
    if (count > 0) {
      projectCounts[projectSlug] = count;
    }
  }

  return { messages: allMessages, newWatermarks, projectCounts };
}

/**
 * Deduplicates messages by content hash, groups them by project, and
 * splits each project's messages into chunks of at most maxWordsPerChunk.
 * Nothing is truncated — a large project simply produces multiple chunks.
 * Word count is used instead of character count because it's a much better
 * proxy for tokens (~1.3 tokens per word for mixed English/code).
 */
export function buildChunks(
  result: DigestResult,
  maxWordsPerChunk: number = 100_000,
): Chunk[] {
  const seen = new Set<string>();
  const byProject: Record<string, string[]> = {};

  const sorted = [...result.messages].sort(
    (a, b) => b.timestampMs - a.timestampMs,
  );

  for (const msg of sorted) {
    const normalized = msg.text.toLowerCase().replace(/\s+/g, " ").trim();
    const hash = createHash("md5").update(normalized).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);

    if (!byProject[msg.project]) byProject[msg.project] = [];
    byProject[msg.project].push(msg.text);
  }

  const chunks: Chunk[] = [];

  for (const [project, msgs] of Object.entries(byProject)) {
    let text = "";
    let wordCount = 0;
    let count = 0;

    for (const m of msgs) {
      const entry = `- ${m.replace(/\n/g, "\n  ")}\n\n`;
      const entryWords = entry.split(/\s+/).filter(Boolean).length;

      if (wordCount + entryWords > maxWordsPerChunk && count > 0) {
        chunks.push({ project, text, messageCount: count });
        text = "";
        wordCount = 0;
        count = 0;
      }

      text += entry;
      wordCount += entryWords;
      count++;
    }

    if (count > 0) {
      chunks.push({ project, text, messageCount: count });
    }
  }

  return chunks;
}

/** Concatenates text content blocks from a parsed transcript line. */
function extractFullText(parsed: TranscriptLine): string {
  const content = parsed.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

/**
 * Pulls text from <user_query> tags. Falls back to the full message with
 * system-injected tags stripped when no user_query tags are found.
 */
function extractUserQueries(text: string): string[] {
  const fromTags = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)]
    .map((m) => m[1].trim())
    .filter((s) => s.length > 0);
  if (fromTags.length > 0) return fromTags;

  let stripped = text;
  for (const pattern of SYSTEM_TAG_PATTERNS) {
    stripped = stripped.replace(pattern, "");
  }
  stripped = stripped.trim();
  return stripped.length > 5 ? [stripped] : [];
}

/**
 * Resolves a Cursor project slug (e.g. "Users-aidenhadisi-ezoicgit-cursor-distill")
 * back to its filesystem path ("/Users/aidenhadisi/ezoicgit/cursor-distill") using
 * greedy directory probing. Returns null when the slug can't be resolved.
 *
 * Cursor encodes '/' as '-', which is lossy when directory names contain hyphens.
 * We walk from the filesystem root, at each level trying the longest hyphen-joined
 * token run that names an existing directory, then falling back to shorter runs.
 */
export function resolveProjectSlug(slug: string): string | null {
  return probe("/", slug.split("-"), 0);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Longest-first greedy walk: at each level try the longest hyphen-joined token run. */
function probe(base: string, tokens: string[], index: number): string | null {
  if (index >= tokens.length) return base;

  for (let end = tokens.length; end > index; end--) {
    const full = join(base, tokens.slice(index, end).join("-"));
    if (!isDirectory(full)) continue;
    if (end === tokens.length) return full;
    const result = probe(full, tokens, end);
    if (result !== null) return result;
  }
  return null;
}

/**
 * Builds a slug → absolute path mapping for all project directories.
 * Exported for injection into the synthesis prompt.
 */
export function resolveAllProjectSlugs(slugs: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const slug of slugs) {
    const resolved = resolveProjectSlug(slug);
    if (resolved) map[slug] = resolved;
  }
  return map;
}

/** Recursively finds all .jsonl files under a directory. */
async function findJsonlFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const files: string[] = [];

  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}
