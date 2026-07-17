import pc from "picocolors";
import { Listr } from "listr2";
import type { Chunk } from "./extract.js";
import type { ChunkOutcome, Observation } from "./agent.js";

const EXTRACT_CONCURRENCY = 4;

function isInteractive(): boolean {
	return process.stdout.isTTY === true;
}

export const c = {
	success: pc.green,
	error: pc.red,
	warn: pc.yellow,
	info: pc.cyan,
	dim: pc.dim,
	bold: pc.bold,
};

/** Symbols that adapt to TTY vs piped output. */
export const sym = {
	get check() {
		return isInteractive() ? pc.green("✔") : "[done]";
	},
	get cross() {
		return isInteractive() ? pc.red("✖") : "[fail]";
	},
	get bullet() {
		return isInteractive() ? pc.dim("•") : "-";
	},
};

type ChunkRunner = (chunk: Chunk, index: number) => Promise<ChunkOutcome>;

/**
 * Runs extraction over every chunk with live progress (TTY) or plain logs
 * (piped). Returns the collected observations; failed chunks contribute none.
 */
export async function runExtractionTasks(
	chunks: Chunk[],
	model: string,
	runChunk: ChunkRunner,
): Promise<Observation[]> {
	const header = `${c.bold("Stage 1")} ${c.dim("·")} extract ${c.dim(`(${model})`)}`;
	console.log(`\n${header}`);

	if (isInteractive()) {
		return extractInteractive(chunks, runChunk);
	}
	return extractPlain(chunks, runChunk);
}

/** Runs synthesis with a spinner (TTY) or plain log (piped). */
export async function withSynthesisSpinner<T>(
	observationCount: number,
	model: string,
	fn: () => Promise<T>,
): Promise<T> {
	const header = `${c.bold("Stage 2")} ${c.dim("·")} synthesize ${c.dim(`(${model})`)}`;
	console.log(`\n${header}`);

	if (!isInteractive()) {
		console.log(`  Analyzing ${observationCount} observation(s)...`);
		const start = Date.now();
		const result = await fn();
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		console.log(`  Synthesis complete (${elapsed}s).`);
		return result;
	}

	let result!: T;
	await new Listr([
		{
			title: `Analyzing ${observationCount} observation(s)...`,
			task: async (_ctx, task) => {
				const start = Date.now();
				result = await fn();
				const elapsed = ((Date.now() - start) / 1000).toFixed(1);
				task.title = `Analyzed ${observationCount} observation(s) ${pc.dim(`(${elapsed}s)`)}`;
			},
		},
	]).run();
	return result;
}

/** Prints the run summary with colored artifact list. */
export function printRunSummary(
	runId: string,
	written: Array<{ action: string; type: string; scope: string; path: string }>,
): void {
	console.log(`\n${c.bold(`Run ${runId} complete.`)}`);
	if (written.length === 0) {
		console.log(c.dim("No new artifacts created."));
	} else {
		console.log(`Wrote ${c.bold(String(written.length))} artifact(s):`);
		for (const e of written) {
			const prefix = e.action === "created" ? c.success("+") : c.warn("~");
			console.log(`  ${prefix} ${e.type} ${c.dim(`(${e.scope})`)}: ${e.path}`);
		}
	}
	console.log(c.dim(`Logs: ~/.cursor-distill/runs/${runId}/`));
}

async function extractInteractive(
	chunks: Chunk[],
	runChunk: ChunkRunner,
): Promise<Observation[]> {
	const observations: Observation[] = [];

	const tasks = new Listr(
		chunks.map((chunk, i) => {
			const name = truncateProject(chunk.project);
			return {
				title: `${name} ${pc.dim(`(${chunk.messageCount} msgs)`)}`,
				task: async (_ctx: unknown, task: { title: string }) => {
					const outcome = await runChunk(chunk, i);
					observations.push(...outcome.observations);
					if (outcome.error) {
						task.title = `${pc.red(name)} — ${outcome.error} ${pc.dim(`(${outcome.elapsed}s)`)}`;
						throw new Error(outcome.error);
					}
					task.title = `${name} ${pc.dim("→")} ${pc.green(`${outcome.observations.length} obs`)} ${pc.dim(`(${outcome.elapsed}s)`)}`;
				},
			};
		}),
		{
			concurrent: EXTRACT_CONCURRENCY,
			exitOnError: false,
			rendererOptions: { collapseErrors: false },
		},
	);

	try {
		await tasks.run();
	} catch {
		// Failed subtasks already update their titles; extraction is lossy by design.
	}

	return observations;
}

async function extractPlain(
	chunks: Chunk[],
	runChunk: ChunkRunner,
): Promise<Observation[]> {
	const observations: Observation[] = [];
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < chunks.length) {
			const index = nextIndex++;
			const chunk = chunks[index];
			const outcome = await runChunk(chunk, index);
			observations.push(...outcome.observations);
			const name = truncateProject(chunk.project);
			if (outcome.error) {
				console.log(`  [failed]  ${name} — ${outcome.error} (${outcome.elapsed}s)`);
			} else {
				console.log(
					`  [done]    ${name} → ${outcome.observations.length} obs (${outcome.elapsed}s)`,
				);
			}
		}
	}

	await Promise.all(
		Array.from(
			{ length: Math.min(EXTRACT_CONCURRENCY, chunks.length) },
			() => worker(),
		),
	);
	return observations;
}

/** Shortens a project slug like "Users-jane-projects-myapp" to "projects-myapp". */
function truncateProject(slug: string): string {
	const parts = slug.split("-");
	return parts.length > 2 ? parts.slice(2).join("-") : slug;
}
