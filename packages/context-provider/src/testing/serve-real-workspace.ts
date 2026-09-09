/**
 * Seed a real DuckDB-backed engram workspace, then serve it with the shipped
 * binary and query it over the wire — the demonstration #1084's acceptance
 * asks for.
 *
 * Run by hand, not by the test suite. The DuckDB adapter needs a native module
 * that is an optional dependency, so a suite that required it would skip
 * wherever it is absent, and a skipped test proves nothing. This is how a
 * person confirms the provider serves a real store rather than the fake one
 * `stdio.test.ts` drives:
 *
 *     pnpm --filter @oxagen/context-provider exec tsx \
 *       src/testing/serve-real-workspace.ts
 *
 * Three processes, and each split is load-bearing. The seeder is its own
 * because DuckDB opens a file as a single writer and a process that has held
 * the database keeps the lock. The provider is its own because that is how a
 * host runs it. This one only writes envelopes and reads them back.
 *
 * It writes to a temporary database and removes it on the way out.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORG = "acme";
const WORKSPACE = "platform";

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the workspace root from ${HERE}`);
}

const TSX = join(repoRoot(), "node_modules", ".bin", "tsx");

interface DemoFrame {
  kind: string;
  title: string;
  uri?: string;
  score: number;
  token_cost: number;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oxagen-context-provider-"));
  const dbPath = join(dir, "engram.duckdb");

  try {
    const seed = spawnSync(
      TSX,
      [join(HERE, "seed-real-workspace.ts"), dbPath],
      {
        encoding: "utf8",
      },
    );
    if (seed.status !== 0) {
      console.error(`seeding failed:\n${seed.stdout}${seed.stderr}`);
      process.exitCode = 1;
      return;
    }
    console.log(`seeded a real engram workspace at ${dbPath}`);

    const frames = await askProvider(dbPath);
    console.log(`\nthe provider returned ${frames.length} frame(s):\n`);
    for (const frame of frames) {
      console.log(
        `  ${frame.kind}  score=${frame.score}  token_cost=${frame.token_cost}`,
      );
      console.log(`    ${frame.title}`);
      console.log(`    ${frame.uri}`);
    }
    if (frames.length === 0) {
      console.error("\nno frames: the provider did not serve the real store");
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Start the shipped binary against `dbPath` and ask it one question. */
function askProvider(dbPath: string): Promise<DemoFrame[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(TSX, [join(HERE, "..", "bin.ts")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        OXAGEN_CONTEXT_ORG: ORG,
        OXAGEN_CONTEXT_WORKSPACE: WORKSPACE,
        ENGRAM_DUCKDB_PATH: dbPath,
      },
    });

    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("the provider did not answer within 30s"));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;

        const envelope = JSON.parse(line) as {
          type: string;
          result?: { frames: DemoFrame[] };
        };
        if (envelope.type === "handshake_ack") {
          console.log("handshake acknowledged");
          child.stdin.write(
            `${JSON.stringify({
              type: "query",
              id: "demo",
              query: {
                goal: "why did the deploy fail",
                query_text: "deploy failed",
                max_frames: 5,
                max_tokens: 500,
              },
            })}\n`,
          );
          continue;
        }
        if (envelope.type === "frames") {
          clearTimeout(timer);
          child.kill();
          resolvePromise(envelope.result?.frames ?? []);
          return;
        }
      }
    });

    child.on("error", rejectPromise);
    child.stdin.write(
      `${JSON.stringify({
        type: "handshake",
        protocol_version: "contextgraph/1.0-draft",
      })}\n`,
    );
  });
}

void main();
