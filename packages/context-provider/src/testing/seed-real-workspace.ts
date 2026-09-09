/**
 * Seed a real DuckDB-backed engram workspace at the path given as argv[2].
 *
 * Its own process, and that is not incidental: DuckDB opens a file as a single
 * writer, and a process that has held the database keeps the lock in a way a
 * later reader in the same process tree cannot get past. Seeding here and
 * serving there is also what actually happens in a deployment — the app writes
 * the memory, the provider serves it.
 */
import { remember } from "@oxagen/engram";
import { createStore } from "@oxagen/engram/store";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("usage: seed-real-workspace.ts <duckdb path>\n");
  process.exit(2);
}

const store = createStore({ duckdbPath: dbPath });
const namespace = { org: "acme", workspace: "platform" };

for (const event of [
  { event: "deploy", payload: { text: "the deploy failed at 3am" } },
  { event: "rollback", payload: { text: "rollback takes four minutes" } },
  { event: "note", payload: { text: "the cache was cold" } },
]) {
  await remember(store, event, {
    namespace,
    provenance: {
      author: "agent:demo",
      derivedFrom: [],
      timestamp: Date.now(),
    },
  });
}
await store.close();
process.stdout.write("seeded\n");
