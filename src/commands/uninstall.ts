import { rm } from "node:fs/promises";
import { removeSchedule } from "../scheduler.js";
import { dataDir } from "../store.js";
import { c, sym } from "../ui.js";

/** Removes the cron schedule and optionally deletes all cursor-distill data. */
export async function uninstallCommand(opts: {
  purge?: boolean;
}): Promise<void> {
  const removed = removeSchedule();
  if (removed) {
    console.log(`${sym.check} Cron schedule removed.`);
  } else {
    console.log(c.dim("No cron schedule found."));
  }

  if (opts.purge) {
    const dir = dataDir();
    await rm(dir, { recursive: true, force: true });
    console.log(`${sym.check} Deleted ${c.dim(dir)}`);
  } else {
    console.log(c.dim("Config and data preserved at ~/.cursor-distill/"));
    console.log(c.dim("Use --purge to delete everything."));
  }
}
