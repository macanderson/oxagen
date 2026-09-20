/** Two PostgreSQL transactions compete for the last seat (#2208). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import { assertSeatAvailable, SeatLimitError } from "../src/seats";

const ORG = "00000000-0000-0000-0088-000000000001";
const ACTOR = "00000000-0000-0000-0088-000000000002";
const options = { max: 1, prepare: false } as const;
const admin = postgres(process.env["DATABASE_URL"]!, options);
const firstClient = postgres(process.env["DATABASE_URL"]!, options);
const secondClient = postgres(process.env["DATABASE_URL"]!, options);
const firstDb = drizzle(firstClient, { schema, casing: "snake_case" });
const secondDb = drizzle(secondClient, { schema, casing: "snake_case" });

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM org.invitations WHERE org_id = ${ORG}`;
    await tx`DELETE FROM org.organizations WHERE id = ${ORG}`;
  });
}

beforeAll(async () => {
  await cleanup();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG}, 'seat_concurrency_org', 'Seat concurrency',
         'seat-concurrency-test', 'seatcx', 'free', 'active', 'business')
    `;
  });
});

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await Promise.all([admin.end(), firstClient.end(), secondClient.end()]);
  }
});

async function insertInvitation(tx: Tx, email: string): Promise<void> {
  await tx.insert(schema.invitations).values({
    orgId: ORG,
    email,
    role: "Member",
    status: "pending",
    invitedByUserId: ACTOR,
  });
}

describe("seat reservation with PostgreSQL", () => {
  it("reserves the final free seat once when invitations overlap", async () => {
    let releaseFirst!: () => void;
    let signalFirstChecked!: () => void;
    let signalSecondStarted!: (pid: number) => void;
    const firstChecked = new Promise<void>((resolve) => {
      signalFirstChecked = resolve;
    });
    const secondStarted = new Promise<number>((resolve) => {
      signalSecondStarted = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = firstDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
      await assertSeatAvailable(ORG, tx);
      signalFirstChecked();
      await holdFirst;
      await insertInvitation(tx, "first@seat.example");
    });
    await Promise.race([firstChecked, first]);

    let secondSettled = false;
    const second = secondDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
      const rows = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      signalSecondStarted(rows[0]!.pid);
      await assertSeatAvailable(ORG, tx);
      await insertInvitation(tx, "second@seat.example");
    });
    // Attach rejection handlers before the transaction can refuse its seat.
    const outcomes = Promise.allSettled([first, second]);
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    let blocked = false;
    try {
      const pid = await Promise.race([secondStarted, second.then(() => 0)]);
      const deadline = Date.now() + 5_000;
      while (!secondSettled && Date.now() < deadline) {
        const [row] = await admin<{ blocked: boolean }[]>`
          SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked
        `;
        blocked = row?.blocked === true;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseFirst();
    }
    const result = await outcomes;
    expect(blocked).toBe(true);
    expect(result[0]?.status).toBe("fulfilled");
    expect(result[1]?.status).toBe("rejected");
    if (result[1]?.status === "rejected") {
      expect(result[1].reason).toBeInstanceOf(SeatLimitError);
    }
    const [count] = await admin<{ total: number }[]>`
      SELECT count(*)::int AS total FROM org.invitations WHERE org_id = ${ORG}
    `;
    expect(count?.total).toBe(1);
  }, 15_000);
});
