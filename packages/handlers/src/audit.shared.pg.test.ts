// Audit keeps the words a row recorded and shows them under one label (#4325,
// decision 5). The rename of the steering record capabilities kept no alias,
// so a security event recorded before it still names the retired capability.
// The read shows that row under the current name, and a filter on either name
// finds the rows recorded under both.
//
// The retired name is read from iam.capability_renames, which the rename's
// migration filled, so the test spells only the current name.
import { describe, expect, it } from "vitest";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { auditConditions, readAuditEvents } from "./audit.shared";

const CURRENT = "publish_steering_record";

describe.skipIf(!process.env.DATABASE_URL)(
  "audit labels against Postgres",
  () => {
    it("shows a row recorded under a retired name, and filters both names, under the current name", async () => {
      const orgId = crypto.randomUUID();
      const retired = await withSystemDb((tx) =>
        tx
          .select({ name: schema.capabilityRenames.retiredName })
          .from(schema.capabilityRenames)
          .where(eq(schema.capabilityRenames.currentName, CURRENT)),
      );
      expect(retired).toHaveLength(1);
      const before = retired[0]!.name;
      expect(before).not.toBe(CURRENT);

      try {
        await withSystemDb((tx) =>
          tx.insert(schema.securityEvents).values([
            {
              orgId,
              eventType: "capability.invoke_allowed",
              capability: before,
              outcome: "allow",
              requestId: "req_before",
              occurredAt: new Date("2026-09-20T12:00:00.000Z"),
            },
            {
              orgId,
              eventType: "capability.invoke_allowed",
              capability: CURRENT,
              outcome: "allow",
              requestId: "req_after",
              occurredAt: new Date("2026-10-02T12:00:00.000Z"),
            },
            {
              orgId,
              eventType: "capability.invoke_allowed",
              capability: "list_runs",
              outcome: "allow",
              requestId: "req_other",
              occurredAt: new Date("2026-10-02T13:00:00.000Z"),
            },
          ]),
        );

        const page = { limit: 10, offset: 0 };
        const all = await withSystemDb((tx) =>
          readAuditEvents(tx, auditConditions(orgId, null, {}), page),
        );
        expect(
          all.map((row) => [row.event.requestId, row.event.capability]),
        ).toEqual([
          ["req_other", "list_runs"],
          ["req_after", CURRENT],
          ["req_before", CURRENT],
        ]);

        for (const name of [CURRENT, before]) {
          const filtered = await withSystemDb((tx) =>
            readAuditEvents(
              tx,
              auditConditions(orgId, null, { capability: name }),
              page,
            ),
          );
          expect(filtered.map((row) => row.event.requestId)).toEqual([
            "req_after",
            "req_before",
          ]);
        }

        // The row itself keeps the name it recorded.
        const stored = await withSystemDb((tx) =>
          tx
            .select({ capability: schema.securityEvents.capability })
            .from(schema.securityEvents)
            .where(
              and(
                eq(schema.securityEvents.orgId, orgId),
                eq(schema.securityEvents.requestId, "req_before"),
              ),
            ),
        );
        expect(stored).toEqual([{ capability: before }]);
      } finally {
        await withSystemDb((tx) =>
          tx
            .delete(schema.securityEvents)
            .where(eq(schema.securityEvents.orgId, orgId)),
        );
      }
    });
  },
);
