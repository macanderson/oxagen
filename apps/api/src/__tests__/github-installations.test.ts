/**
 * Unit tests for src/routes/v1/github-installations.ts — the platform-scoped
 * github_installations registry upsert.
 *
 * Strategy: mock @oxagen/database (withSystemDb + schema) and capture the
 * insert().values(v).onConflictDoUpdate(c) arguments the function builds, so the
 * lifecycle + metadata-merge rules can be asserted without a real DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withSystemDb: vi.fn() }));

vi.mock("@oxagen/database", () => ({
  schema: { githubInstallations: { installationId: "gi.installationId" } },
  withSystemDb: mocks.withSystemDb,
}));

import { upsertGithubInstallation } from "../routes/v1/github-installations";

interface Captured {
  values?: Record<string, unknown>;
  conflict?: { target: unknown; set: Record<string, unknown> };
}

/** Wire withSystemDb to run the tx callback against spies, capturing the args. */
function captureTx(): Captured {
  const captured: Captured = {};
  const chain = {
    values: vi.fn((v: Record<string, unknown>) => {
      captured.values = v;
      return chain;
    }),
    onConflictDoUpdate: vi.fn(
      (c: { target: unknown; set: Record<string, unknown> }) => {
        captured.conflict = c;
        return chain;
      },
    ),
  };
  const tx = { insert: vi.fn(() => chain) };
  mocks.withSystemDb.mockImplementation((fn: (t: unknown) => unknown) =>
    fn(tx),
  );
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertGithubInstallation", () => {
  it("inserts the installation id + account metadata, live by default", async () => {
    const cap = captureTx();
    await upsertGithubInstallation({
      installationId: "42",
      accountLogin: "acme",
      accountType: "Organization",
    });
    expect(cap.values).toMatchObject({
      installationId: "42",
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
      deletedAt: null,
    });
    expect(cap.conflict?.set).toMatchObject({
      accountLogin: "acme",
      accountType: "Organization",
    });
    // A plain metadata refresh must NOT touch lifecycle flags (never un-suspend).
    expect(cap.conflict?.set).not.toHaveProperty("suspendedAt");
    expect(cap.conflict?.set).not.toHaveProperty("deletedAt");
  });

  it("reactivate clears suspended_at and deleted_at on conflict (fresh install / unsuspend)", async () => {
    const cap = captureTx();
    await upsertGithubInstallation({ installationId: "42", reactivate: true });
    expect(cap.conflict?.set.suspendedAt).toBeNull();
    expect(cap.conflict?.set.deletedAt).toBeNull();
  });

  it("writes an explicit deletedAt on insert and conflict (uninstall)", async () => {
    const cap = captureTx();
    const when = new Date("2026-07-09T00:00:00.000Z");
    await upsertGithubInstallation({ installationId: "42", deletedAt: when });
    expect(cap.values?.deletedAt).toEqual(when);
    expect(cap.conflict?.set.deletedAt).toEqual(when);
  });

  it("writes an explicit suspendedAt (suspend)", async () => {
    const cap = captureTx();
    const when = new Date("2026-07-09T00:00:00.000Z");
    await upsertGithubInstallation({ installationId: "42", suspendedAt: when });
    expect(cap.values?.suspendedAt).toEqual(when);
    expect(cap.conflict?.set.suspendedAt).toEqual(when);
  });

  it("does not overwrite metadata with unknown values on conflict", async () => {
    const cap = captureTx();
    await upsertGithubInstallation({ installationId: "42" }); // id only
    expect(cap.conflict?.set).not.toHaveProperty("accountLogin");
    expect(cap.conflict?.set).not.toHaveProperty("accountId");
  });

  it("targets the installation_id unique constraint on conflict", async () => {
    const cap = captureTx();
    await upsertGithubInstallation({ installationId: "42" });
    expect(cap.conflict?.target).toBe("gi.installationId");
  });
});
