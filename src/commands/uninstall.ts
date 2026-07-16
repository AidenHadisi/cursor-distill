import { rm } from "node:fs/promises";
import { removeSchedule } from "../scheduler.js";
import { dataDir } from "../store.js";

/** Removes the cron schedule and optionally deletes all cursor-distill data. */
export async function uninstallCommand(opts: {
  purge?: boolean;
}): Promise<void> {
  const removed = removeSchedule();
  if (removed) {
    console.log("Cron schedule removed.");
  } else {
    console.log("No cron schedule found.");
  }

  if (opts.purge) {
    const dir = dataDir();
    await rm(dir, { recursive: true, force: true });
    console.log(`Deleted ${dir}`);
  } else {
    console.log("Config and data preserved at ~/.cursor-distill/");
    console.log("Use --purge to delete everything.");
  }
}
