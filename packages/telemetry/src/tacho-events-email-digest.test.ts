/**
 * The `tacho_events` table must carry no readable email address (#3072), and
 * the backfill that removed the ones already written must compute the same
 * digest the collector writes — otherwise a backfilled row would never join a
 * newly written one for the same person.
 *
 * These read the committed migration files rather than trusting a description
 * of them, so reintroducing the plaintext column, or drifting the SQL away
 * from `digestUserEmail`, fails here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENESIS_CURSOR,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { tachoEventRow } from "./tacho-events";
import { tachoEventsColumns } from "./tacho-events-ddl";

const SESSION = sessionUuid("tch_host", "sess-1");

/** A valid genesis event carrying whatever anthropic block a test needs. */
function genesis(anthropic: Record<string, string>): TachoEvent {
  const unsealed = {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "sess-1",
    session_uuid: SESSION,
    root_session_uuid: SESSION,
    ts: "2026-09-08T10:06:03.000Z",
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
    },
    anthropic,
    kind: "agent_start",
    body: { session_start_source: "startup" },
  } as UnsealedTachoEvent;
  return sealEvent(unsealed, GENESIS_CURSOR).event;
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  readFileSync(join(here, "migrations", file), "utf8");

const CREATE = "0027_tacho_events.sql";
const DIGEST = "0028_tacho_events_email_digest.sql";

describe("tacho_events carries no email address", () => {
  it("has no plaintext column in the generated table", () => {
    const names = tachoEventsColumns().map((column) => column.name);
    expect(names).not.toContain("anthropic_user_email");
    expect(names).toContain("anthropic_user_email_digest");
    for (const name of names) expect(name).not.toMatch(/email$/);
  });

  it("creates the table with the digest column and nothing else email-shaped", () => {
    const sql = read(CREATE);
    expect(sql).toContain("anthropic_user_email_digest String");
    expect(sql).not.toMatch(/^\s*anthropic_user_email String,?$/m);
  });

  it("drops the plaintext column from planes that already have it", () => {
    const sql = read(DIGEST);
    expect(sql).toContain(
      "ALTER TABLE tacho_events DROP COLUMN IF EXISTS anthropic_user_email;",
    );
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS anthropic_user_email_digest String",
    );
    // The drop has to be the last statement: anything after it that still
    // reads the column would fail on a plane that has already run this.
    const statements = sql
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith("--"));
    expect(statements[statements.length - 1]).toContain(
      "DROP COLUMN IF EXISTS anthropic_user_email",
    );
  });

  it("does not backfill, and says so", () => {
    const sql = read(DIGEST);
    // A keyed digest cannot be computed here: ClickHouse has no HMAC function,
    // and passing the key into a statement would write it to the query log.
    // So the rows already written lose the attribute — the addresses are gone
    // rather than re-encoded — and no statement may reference the old column
    // except to drop it.
    const statements = sql
      .split(";")
      .map((part) =>
        part
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((part) => part.length > 0);
    expect(statements).toHaveLength(2);
    const executed = statements.join(";").toLowerCase();
    expect(executed).not.toContain("update");
    expect(executed).not.toContain("sha256");
    for (const statement of statements) {
      if (statement.includes("anthropic_user_email ")) {
        expect(statement).toContain("DROP COLUMN");
      }
    }
  });

  it("stamps the column server-side, so no producer value reaches it", () => {
    const row = tachoEventRow(
      {
        event: genesis({ user_email: "ada@example.com" }),
        chainVerified: true,
        userEmailDigest: "hmac-sha256:" + "a".repeat(64),
      },
      "2026-09-17T00:00:00.000Z",
    );
    expect(row["anthropic_user_email_digest"]).toBe(
      "hmac-sha256:" + "a".repeat(64),
    );
    expect(JSON.stringify(row)).not.toContain("@example.com");
  });

  it("writes an empty digest when the deployment stamped none", () => {
    const row = tachoEventRow(
      { event: genesis({}), chainVerified: true },
      "2026-09-17T00:00:00.000Z",
    );
    expect(row["anthropic_user_email_digest"]).toBe("");
  });
});
