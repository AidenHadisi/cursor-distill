import { readLedger, type LedgerEntry } from "../store.js";
import { c } from "../ui.js";

/** Prints a breakdown of all artifacts created by cursor-distill. */
export async function statsCommand(opts: { json?: boolean }): Promise<void> {
  const ledger = await readLedger();

  if (opts.json) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }

  if (ledger.length === 0) {
    console.log(c.dim("No artifacts created yet. Run: cursor-distill run --now"));
    return;
  }

  const byType: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  const byProject: Record<string, LedgerEntry[]> = {};

  for (const e of ledger) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    byScope[e.scope] = (byScope[e.scope] ?? 0) + 1;
    const key = e.scope === "global" ? "(global)" : (e.project ?? "unknown");
    (byProject[key] ??= []).push(e);
  }

  console.log(`\n${c.bold("cursor-distill stats")}\n${"─".repeat(40)}\n`);
  console.log(`Total artifacts: ${c.bold(String(ledger.length))}\n`);

  console.log(c.bold("By type:"));
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${c.info(type)}: ${count}`);
  }

  console.log(`\n${c.bold("By scope:")}`);
  for (const [scope, count] of Object.entries(byScope)) {
    console.log(`  ${c.info(scope)}: ${count}`);
  }

  console.log(`\n${c.bold("By location:")}`);
  for (const [project, entries] of Object.entries(byProject).sort()) {
    console.log(`\n  ${c.bold(project)}:`);
    for (const e of entries) {
      const prefix = e.action === "created" ? c.success("+") : c.warn("~");
      console.log(`    ${prefix} ${e.type}: ${c.dim(e.path)}`);
    }
  }

  console.log(
    `\n${c.dim(`${new Set(ledger.map((e) => e.runId)).size} run(s) have produced artifacts.`)}`,
  );
}
