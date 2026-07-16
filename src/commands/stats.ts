import { readLedger, type LedgerEntry } from "../store.js";

/** Prints a breakdown of all artifacts created by cursor-distill. */
export async function statsCommand(opts: { json?: boolean }): Promise<void> {
  const ledger = await readLedger();

  if (opts.json) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }

  if (ledger.length === 0) {
    console.log("No artifacts created yet. Run: cursor-distill run --now");
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

  console.log(`\ncursor-distill stats\n${"=".repeat(40)}\n`);
  console.log(`Total artifacts: ${ledger.length}\n`);

  console.log("By type:");
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log("\nBy scope:");
  for (const [scope, count] of Object.entries(byScope)) {
    console.log(`  ${scope}: ${count}`);
  }

  console.log("\nBy location:");
  for (const [project, entries] of Object.entries(byProject).sort()) {
    console.log(`\n  ${project}:`);
    for (const e of entries) {
      console.log(`    ${e.action} ${e.type}: ${e.path}`);
    }
  }

  console.log(
    `\n${new Set(ledger.map((e) => e.runId)).size} run(s) have produced artifacts.`,
  );
}
