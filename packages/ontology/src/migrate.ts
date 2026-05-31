import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDriver, session } from "./client.js";

// Each Cypher statement runs in its own transaction so a single bad DDL
// doesn't roll back the whole schema.
function splitStatements(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "schema.cypher"), "utf8");
  const statements = splitStatements(source);

  const s = session();
  try {
    for (const stmt of statements) {
      await s.run(stmt);
    }
  } finally {
    await s.close();
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  migrate()
    .then(() => closeDriver())
    .then(() => {
      console.log("Neo4j migration complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Neo4j migration failed:", err);
      process.exit(1);
    });
}
