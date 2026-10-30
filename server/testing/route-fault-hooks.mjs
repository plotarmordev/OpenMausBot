// Loaded with --import in isolated fixtures when OMB_TEST_ROUTE_FAULT=1: while <data dir>/fail-thread-read exists,
// reading a thread's active leaf throws an error with no status, so a route fails the way an unexpected fault does.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../store.ts";

const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.OMB_TEST_ROUTE_FAULT !== "1") {
  throw new Error("The route fault requires an explicitly isolated fixture");
}
const marker = join(dataDir, "fail-thread-read");
const activeLeaf = Store.prototype.activeLeaf;
Store.prototype.activeLeaf = function (...args) {
  if (existsSync(marker)) throw new Error("test fault: reading this thread failed");
  return activeLeaf.apply(this, args);
};
