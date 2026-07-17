import pc from "picocolors";
import ora from "ora";
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
 * Runs extraction over every chunk with a single compact progress spinner
 * (TTY) or plain logs (piped). Returns collected observations.
 */
export async function runExtractionTasks(
	chunks: Chunk[],
	model: string,
	runChunk: ChunkRunner,
): Promise<Observation[]> {
	const header = `${c.bold("Stage 1")} ${c.dim("·")} extract ${c.dim(`(${model})`)}`;
	console.log(`\n${header}`);

	const labels = labelChunks(chunks);

	if (isInteractive()) {
		return extractInteractive(chunks, labels, runChunk);
	}
	return extractPlain(chunks, labels, runChunk);
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

	const spinner = ora({
		text: `Analyzing ${observationCount} observation(s)...`,
		discardStdin: false,
	}).start();
	const start = Date.now();
	try {
		const result = await fn();
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		spinner.succeed(`Analyzed ${observationCount} observation(s) ${pc.dim(`(${elapsed}s)`)}`);
		return result;
	} catch (err) {
		spinner.fail(`Synthesis failed ${pc.dim(`(${((Date.now() - start) / 1000).toFixed(1)}s)`)}`);
		throw err;
	}
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
	labels: string[],
	runChunk: ChunkRunner,
): Promise<Observation[]> {
	const observations: Observation[] = [];
	const total = chunks.length;
	let done = 0;
	let failed = 0;
	const running = new Map<number, string>();
	const start = Date.now();

	const spinner = ora({
		text: progressText(0, total, failed, running),
		discardStdin: false,
	}).start();

	function refresh(): void {
		spinner.text = progressText(done, total, failed, running);
	}

	await runPool(chunks, async (chunk, index) => {
		running.set(index, labels[index]);
		refresh();
		const outcome = await runChunk(chunk, index);
		running.delete(index);
		done++;
		observations.push(...outcome.observations);

		if (outcome.error) {
			failed++;
			spinner.stop();
			console.log(
				`  ${sym.cross} ${labels[index]} — ${outcome.error} ${pc.dim(`(${outcome.elapsed}s)`)}`,
			);
			spinner.start(progressText(done, total, failed, running));
		} else {
			refresh();
		}
	});

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	const ok = total - failed;
	const obs = observations.length;
	const summary =
		failed > 0
			? `${ok}/${total} chunks · ${obs} obs · ${pc.red(`${failed} failed`)} ${pc.dim(`(${elapsed}s)`)}`
			: `${total} chunks · ${obs} observation(s) ${pc.dim(`(${elapsed}s)`)}`;
	spinner.succeed(summary);
	return observations;
}

async function extractPlain(
	chunks: Chunk[],
	labels: string[],
	runChunk: ChunkRunner,
): Promise<Observation[]> {
	const observations: Observation[] = [];
	let done = 0;
	let failed = 0;
	const total = chunks.length;

	await runPool(chunks, async (chunk, index) => {
		const outcome = await runChunk(chunk, index);
		done++;
		observations.push(...outcome.observations);
		if (outcome.error) {
			failed++;
			console.log(`  [failed]  ${labels[index]} — ${outcome.error} (${outcome.elapsed}s)`);
		} else {
			console.log(
				`  [done]    ${labels[index]} → ${outcome.observations.length} obs (${outcome.elapsed}s) [${done}/${total}]`,
			);
		}
	});

	if (failed > 0) {
		console.log(`  Extraction: ${total - failed}/${total} ok, ${failed} failed`);
	}
	return observations;
}

async function runPool(
	chunks: Chunk[],
	fn: (chunk: Chunk, index: number) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < chunks.length) {
			const index = nextIndex++;
			await fn(chunks[index], index);
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(EXTRACT_CONCURRENCY, chunks.length) },
			() => worker(),
		),
	);
}

function progressText(
	done: number,
	total: number,
	failed: number,
	running: Map<number, string>,
): string {
	const active = [...running.values()];
	const runningLabel =
		active.length === 0
			? ""
			: ` · ${pc.dim(active.length === 1 ? active[0] : `${active[0]} +${active.length - 1}`)}`;
	const failLabel = failed > 0 ? ` · ${pc.red(`${failed} failed`)}` : "";
	return `${done}/${total}${failLabel}${runningLabel}`;
}

/**
 * Labels for each chunk: short project name, with [i/n] when a project
 * spans multiple chunks.
 */
function labelChunks(chunks: Chunk[]): string[] {
	const totals = new Map<string, number>();
	for (const chunk of chunks) {
		totals.set(chunk.project, (totals.get(chunk.project) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	return chunks.map((chunk) => {
		const name = displayProject(chunk.project);
		const total = totals.get(chunk.project) ?? 1;
		if (total === 1) return name;
		const n = (seen.get(chunk.project) ?? 0) + 1;
		seen.set(chunk.project, n);
		return `${name} [${n}/${total}]`;
	});
}

/** Shortens Cursor project slugs: Users-jane-projects-myapp → projects-myapp. */
function displayProject(slug: string): string {
	const parts = slug.split("-");
	if (parts[0] === "Users" && parts.length > 2) {
		return parts.slice(2).join("-");
	}
	return slug;
}
