#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { formatError } from "./lib/format-error";

// Lightweight schema-presence probe. Each store gets one cheap query;
// non-zero exit blocks the gate. The full drift check belongs in the
// database package once Drizzle introspection lands.

type Result = { name: string; ok: boolean; detail: string };

async function checkPostgres(): Promise<Result> {
  try {
    const url = process.env.DATABASE_URL ?? "postgres://oxagen:oxagen@localhost:5432/oxagen";
    const { stdout } = await execa("psql", [
      url,
      "-tAc",
      "select count(*) from information_schema.schemata where schema_name in ('org','auth','workspace','billing','chat')",
    ]);
    const count = Number(stdout.trim());
    return {
      name: "postgres",
      ok: count >= 5,
      detail: `${count}/5 expected schemas present`,
    };
  } catch (err) {
    return {
      name: "postgres",
      ok: false,
      detail: formatError(err),
    };
  }
}

async function checkClickhouse(): Promise<Result> {
  try {
    const url = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
    const res = await fetch(`${url}/?query=${encodeURIComponent("SHOW TABLES FROM oxagen")}`);
    const text = await res.text();
    if (!res.ok) {
      return { name: "clickhouse", ok: false, detail: text };
    }
    const tables = text.split("\n").filter(Boolean);
    return {
      name: "clickhouse",
      ok: tables.length > 0,
      detail: `${tables.length} tables in oxagen`,
    };
  } catch (err) {
    return {
      name: "clickhouse",
      ok: false,
      detail: formatError(err),
    };
  }
}

async function checkNeo4j(): Promise<Result> {
  try {
    const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
    // Cypher over HTTP is sufficient for a presence check without pulling in the driver here.
    const httpUri = uri.replace(/^bolt:\/\//, "http://").replace(/:7687$/, ":7474");
    const auth = Buffer.from(
      `${process.env.NEO4J_USERNAME ?? "neo4j"}:${process.env.NEO4J_PASSWORD ?? "oxagen-dev"}`,
    ).toString("base64");
    const res = await fetch(`${httpUri}/db/neo4j/tx/commit`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        statements: [{ statement: "CALL db.labels() YIELD label RETURN count(label) AS n" }],
      }),
    });
    const data = (await res.json()) as { results: Array<{ data: Array<{ row: number[] }> }> };
    const n = data.results?.[0]?.data?.[0]?.row?.[0] ?? 0;
    return {
      name: "neo4j",
      ok: typeof n === "number",
      detail: `${n} labels`,
    };
  } catch (err) {
    return {
      name: "neo4j",
      ok: false,
      detail: formatError(err),
    };
  }
}

async function main(): Promise<void> {
  const results = await Promise.all([checkPostgres(), checkClickhouse(), checkNeo4j()]);
  for (const r of results) {
    const tag = r.ok ? kleur.green("ok") : kleur.red("fail");
    console.log(`${tag}  ${r.name.padEnd(10)} ${r.detail}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

main();
