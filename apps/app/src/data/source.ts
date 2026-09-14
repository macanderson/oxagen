// Adapter selection (plan §4.5): the ONLY file that imports an adapter.
import "server-only";
import { liveSource } from "./adapters/live";
import type { DataSource } from "./ports";

/** The data source every page reads through. */
export function dataSource(): DataSource {
  return liveSource;
}
