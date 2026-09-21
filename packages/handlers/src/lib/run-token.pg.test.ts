import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  schema,
  withSystemDb,
  withTenantDb,
  closeDatabase,
} from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, sql } from "drizzle-orm";
import {
  buildLockAttemptForWriteSql,
  createPostgresRunStore,
  type LockedAttemptRow,
} from "@oxagen/run-ledger";
import { postgresCommandStore } from "../tacho.command.dispatch";
import { generateApiKey } from "./api-key-authz";

// CI supplies the migrated database. These witnesses use real row locks and rollback.
describe.skipIf(!process.env.DATABASE_URL)(
  "ledger cancellation transaction",
  () => {
    const scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const runId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const runPublicId = `arun_${crypto.randomUUID().replaceAll("-", "")}`;
    const keyId = crypto.randomUUID();
    const digest = `sha256:${"a".repeat(64)}`;
    const scoped = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);
    const cancel = {
      scope,
      publicId: runPublicId,
      userId: null,
      now: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      reason: null,
    };
    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.agentRuns).values({
          id: runId,
          publicId: runPublicId,
          ...scope,
          surface: "external",
          status: "running",
          spec: {},
          specVersion: 2,
          runKind: "general",
          specDigest: digest,
          initiatingPrincipalId: crypto.randomUUID(),
          agentPrincipalId: crypto.randomUUID(),
          agentId: crypto.randomUUID(),
          agentVersionId: crypto.randomUUID(),
          agentVersionChecksum: digest,
          authorizationSnapshotId: crypto.randomUUID(),
          retentionPolicyId: crypto.randomUUID(),
          retentionPolicyDigest: digest,
          maxAttempts: 3,
        });
        await tx.insert(schema.agentRunAttempts).values({
          id: attemptId,
          ...scope,
          runId,
          attemptNumber: 1,
          workerId: "test-producer",
          engineName: "custom",
          engineVersion: "1",
          engineBuildDigest: digest,
        });
        const key = generateApiKey();
        await tx.insert(schema.apiKeys).values({
          id: keyId,
          ...scope,
          name: "test-run",
          keyHash: key.keyHash,
          keyPrefix: key.keyPrefix,
          scope: {
            purpose: "ledger_run_v1",
            run_id: runId,
            attempt_id: attemptId,
          },
          expiresAt: new Date(Date.now() + 900_000),
        });
      });
    });
    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.tachoControlCommands)
          .where(
            eq(schema.tachoControlCommands.workspaceId, scope.workspaceId),
          );
        await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
        await tx
          .delete(schema.agentRunAttempts)
          .where(eq(schema.agentRunAttempts.id, attemptId));
        await tx.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      });
      await closeDatabase();
    });

    it("rolls back the run fence, credential revocation, and receipt together", async () => {
      const failure = new Error("receipt transaction failed");
      await expect(
        scoped(() =>
          withTenantDb(async (tx) => {
            await postgresCommandStore(tx).cancelLedgerRun(cancel);
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
      await withSystemDb(async (tx) => {
        expect(
          (
            await tx.query.agentRuns.findFirst({
              where: eq(schema.agentRuns.id, runId),
            })
          )?.cancelRequested,
        ).toBe(false);
        expect(
          (
            await tx.query.apiKeys.findFirst({
              where: eq(schema.apiKeys.id, keyId),
            })
          )?.deletedAt,
        ).toBeNull();
        expect(
          await tx
            .select()
            .from(schema.tachoControlCommands)
            .where(eq(schema.tachoControlCommands.targetId, runPublicId)),
        ).toHaveLength(0);
      });
    });

    it("refuses a run outside the workspace without a receipt", async () => {
      await expect(
        scoped(() =>
          withTenantDb((tx) =>
            postgresCommandStore(tx).cancelLedgerRun({
              ...cancel,
              scope: { ...scope, workspaceId: crypto.randomUUID() },
            }),
          ),
        ),
      ).rejects.toMatchObject({ reason: "run_not_found" });
    });

    it("rolls back pause and receipt together, then resumes the same credential", async () => {
      const change = (command: "pause" | "resume") =>
        scoped(() =>
          withTenantDb((tx) =>
            postgresCommandStore(tx).setLedgerPaused({ ...cancel, command }),
          ),
        );
      const failure = new Error("pause receipt failed");
      await expect(
        scoped(() =>
          withTenantDb(async (tx) => {
            await postgresCommandStore(tx).setLedgerPaused({
              ...cancel,
              command: "pause",
            });
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
      await withSystemDb(async (tx) => {
        expect(
          (
            await tx.query.agentRuns.findFirst({
              where: eq(schema.agentRuns.id, runId),
            })
          )?.ingressPaused,
        ).toBe(false);
        expect(
          await tx
            .select()
            .from(schema.tachoControlCommands)
            .where(eq(schema.tachoControlCommands.targetId, runPublicId)),
        ).toHaveLength(0);
      });
      const pauseReceipt = await change("pause");
      expect(await change("pause")).toBe(pauseReceipt);
      await expect(
        scoped(() =>
          createPostgresRunStore().appendAttemptBatch({
            attemptId,
            events: [],
          }),
        ),
      ).rejects.toMatchObject({ reason: "paused" });
      const resumeReceipt = await change("resume");
      expect(await change("resume")).toBe(resumeReceipt);
      await expect(
        scoped(() =>
          createPostgresRunStore().appendAttemptBatch({
            attemptId,
            events: [],
          }),
        ),
      ).resolves.toBeDefined();
      await withSystemDb(async (tx) => {
        const key = await tx.query.apiKeys.findFirst({
          where: eq(schema.apiKeys.id, keyId),
        });
        expect(key?.deletedAt).toBeNull();
        expect(key?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
        const receipts = await tx
          .select()
          .from(schema.tachoControlCommands)
          .where(eq(schema.tachoControlCommands.targetId, runPublicId));
        expect(receipts.map((receipt) => receipt.outcomeDetail).sort()).toEqual(
          ["ledger_ingress_paused", "ledger_ingress_resumed"],
        );
        await tx
          .delete(schema.tachoControlCommands)
          .where(eq(schema.tachoControlCommands.targetId, runPublicId));
      });
    });

    it.each(["pause", "cancel"] as const)(
      "a writer waiting on %s reads the locked row's new fence",
      async (command) => {
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const gotLock = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const cancelling = scoped(() =>
          withTenantDb(async (tx) => {
            const id =
              command === "cancel"
                ? await postgresCommandStore(tx).cancelLedgerRun(cancel)
                : await postgresCommandStore(tx).setLedgerPaused({
                    ...cancel,
                    command,
                  });
            locked();
            await hold;
            return id;
          }),
        );
        await Promise.race([gotLock, cancelling]);
        let pidReady!: (pid: number) => void;
        const pidPromise = new Promise<number>((resolve) => {
          pidReady = resolve;
        });
        const waiting = scoped(() =>
          withTenantDb(async (tx) => {
            const [row] = (await tx.execute(
              sql`SELECT pg_backend_pid() AS pid`,
            )) as unknown as Array<{ pid: number }>;
            if (!row) throw new Error("No database backend id");
            pidReady(row.pid);
            return (await tx.execute(
              buildLockAttemptForWriteSql(attemptId),
            )) as unknown as LockedAttemptRow[];
          }),
        );
        try {
          const pid = await Promise.race([
            pidPromise,
            waiting.then(() => {
              throw new Error(
                "Writer completed before reporting its backend id",
              );
            }),
          ]);
          let blocked = false;
          const deadline = Date.now() + 5000;
          while (!blocked && Date.now() < deadline) {
            const rows = (await withSystemDb((tx) =>
              tx.execute(
                sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`,
              ),
            )) as unknown as Array<{ wait_event_type: string }>;
            blocked = rows[0]?.wait_event_type === "Lock";
            if (!blocked)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
        } finally {
          release();
        }
        const [receipt, rows] = await Promise.all([cancelling, waiting]);
        if (command === "pause") {
          expect(rows[0]?.ingress_paused).toBe(true);
          await expect(
            scoped(() =>
              createPostgresRunStore().appendAttemptBatch({
                attemptId,
                events: [],
              }),
            ),
          ).rejects.toMatchObject({ reason: "paused" });
          await scoped(() =>
            withTenantDb((tx) =>
              postgresCommandStore(tx).setLedgerPaused({
                ...cancel,
                command: "resume",
              }),
            ),
          );
          await withSystemDb((tx) =>
            tx
              .delete(schema.tachoControlCommands)
              .where(eq(schema.tachoControlCommands.targetId, runPublicId)),
          );
          return;
        }
        expect(rows[0]?.cancel_requested).toBe(true);
        expect(
          await scoped(() =>
            withTenantDb((tx) =>
              postgresCommandStore(tx).cancelLedgerRun(cancel),
            ),
          ),
        ).toBe(receipt);
        await withSystemDb(async (tx) => {
          expect(
            (
              await tx.query.apiKeys.findFirst({
                where: eq(schema.apiKeys.id, keyId),
              })
            )?.deletedAt,
          ).not.toBeNull();
          expect(
            await tx
              .select()
              .from(schema.tachoControlCommands)
              .where(
                and(
                  eq(schema.tachoControlCommands.publicId, receipt),
                  eq(schema.tachoControlCommands.outcome, "applied"),
                ),
              ),
          ).toHaveLength(1);
        });
        await expect(
          scoped(() =>
            createPostgresRunStore().appendAttemptBatch({
              attemptId,
              events: [],
            }),
          ),
        ).rejects.toMatchObject({ reason: "cancelled" });
        await expect(
          scoped(() =>
            withTenantDb((tx) =>
              postgresCommandStore(tx).setLedgerPaused({
                ...cancel,
                command: "resume",
              }),
            ),
          ),
        ).rejects.toMatchObject({ reason: "run_cancelled" });
        await withSystemDb(async (tx) => {
          expect(
            (
              await tx.query.apiKeys.findFirst({
                where: eq(schema.apiKeys.id, keyId),
              })
            )?.deletedAt,
          ).not.toBeNull();
          expect(
            (
              await tx.query.agentRuns.findFirst({
                where: eq(schema.agentRuns.id, runId),
              })
            )?.cancelRequested,
          ).toBe(true);
        });
      },
      15_000,
    );
  },
);
