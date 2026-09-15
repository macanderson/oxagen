// The one composition point (ARCHITECTURE.md §3.3): routes hand this to a
// feature, and a feature reads only through the DataSource it is given.
import "server-only";
import { liveSource } from "./live";

export function dataSource(): typeof liveSource {
  return liveSource;
}
