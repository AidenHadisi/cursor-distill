import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { WatermarkState } from "./store.js";

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

/** The final digest ready to feed into the headless agent. */
export interface DigestOutput {
  digest: string;
  totalMessages: number;
  projectCounts: Record<string, number>;
  newWatermarks: Record<string, number>;
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
 * truncates the result to fit within maxChars.
 */
export function buildDigest(
  result: DigestResult,
  maxChars: number = 100_000,
): DigestOutput {
  const seen = new Set<string>();
  const byProject: Record<string, string[]> = {};
  let totalMessages = 0;

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
    totalMessages++;
  }

  const sections: string[] = [];
  let totalLen = 0;

  for (const [project, msgs] of Object.entries(byProject)) {
    const header = `\n## Project: ${project} (${msgs.length} messages)\n`;
    let section = header;

    for (const m of msgs) {
      const entry = `\n- ${m.replace(/\n/g, "\n  ")}\n`;
      if (totalLen + section.length + entry.length > maxChars) break;
      section += entry;
    }

    sections.push(section);
    totalLen += section.length;
    if (totalLen >= maxChars) break;
  }

  return {
    digest: sections.join("\n"),
    totalMessages,
    projectCounts: result.projectCounts,
    newWatermarks: result.newWatermarks,
  };
}

/** Concatenates text content blocks from a parsed transcript line. */
function extractFullText(parsed: TranscriptLine): string {
  if (typeof parsed.message?.content === "string") {
    return parsed.message.content;
  }
  if (Array.isArray(parsed.message?.content)) {
    return parsed.message!.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }
  return "";
}

/**
 * Pulls text from <user_query> tags. Falls back to the full message with
 * system-injected tags stripped when no user_query tags are found.
 */
function extractUserQueries(text: string): string[] {
  const regex = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const cleaned = m[1].trim();
    if (cleaned.length > 0) matches.push(cleaned);
  }
  if (matches.length === 0) {
    let stripped = text;
    for (const pattern of SYSTEM_TAG_PATTERNS) {
      stripped = stripped.replace(pattern, "");
    }
    stripped = stripped.trim();
    if (stripped.length > 5) matches.push(stripped);
  }
  return matches;
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
