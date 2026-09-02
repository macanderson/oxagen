import { describe, expect, it, beforeEach, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { TEST_CTX as CTX } from "../test-utils/fixtures";
import { agentSandboxRename } from "@oxagen/oxagen/contracts/agent.sandbox.rename";

// A capturing tx double: serves queued select rows AND records the update
// `.set()` payload so we can prove the metadata write is a jsonb MERGE (a SQL
// `||` expression) rather than a plain-object overwrite that would clobber the
// frozen session spec.
const state: {
  selectRows: unknown[];
  capturedSet?: Record<string, unknown>;
  updateCount: number;
} = { selectRows: [], updateCount: 0 };

function makeChain(kind: "select" | "update"): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (onFulfilled: (v: unknown) => unknown) => {
            const value =
              kind === "select" ? (state.selectRows.shift() ?? []) : [];
            return Promise.resolve(value).then(onFulfilled);
          };
        }
        if (prop === "set") {
          return (payload: Record<string, unknown>) => {
            state.capturedSet = payload;
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

const tx = {
  select: () => makeChain("select"),
  update: () => {
    state.updateCount += 1;
    return makeChain("update");
  },
  insert: () => makeChain("update"),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
});

import { agentSandboxRenameHandler } from "./agent.sandbox.rename";

const ROW = {
  id: "uuid-1",
  publicId: "sbx_1",
  sandboxId: "sb-aaa",
  snapshotId: null as string | null,
  image: "agent",
  status: "running",
  driver: "modal",
  metadata: {
    memoryMb: 2048,
    ttlSeconds: 86_400,
    idleTimeoutSeconds: 1_200,
    network: "allow",
    environmentId: "env_9",
  },
};

beforeEach(() => {
  state.selectRows = [];
  state.capturedSet = undefined;
  state.updateCount = 0;
});

describe("agent.sandbox.rename handler", () => {
  it("persists the label via a jsonb merge that preserves other metadata keys", async () => {
    state.selectRows.push([{ ...ROW }]); // getSessionByPublicId

    const out = await agentSandboxRenameHandler(
      { sessionId: "sbx_1", label: "acme refactor" },
      CTX,
    );

    expect(out).toEqual({ sessionId: "sbx_1", label: "acme refactor" });
    expect(state.updateCount).toBe(1);
    // The metadata write is a SQL jsonb `||` merge (a SQL instance), NOT a plain
    // object overwrite — so environmentId/memoryMb/etc. survive the rename.
    expect(state.capturedSet?.metadata).toBeInstanceOf(SQL);
  });

  it("throws SandboxSessionNotFoundError for an unknown session (no write)", async () => {
    state.selectRows.push([]); // getSessionByPublicId → empty

    await expect(
      agentSandboxRenameHandler({ sessionId: "sbx_missing", label: "x" }, CTX),
    ).rejects.toThrow(/was not found in this workspace/);
    expect(state.updateCount).toBe(0);
  });
});

describe("agent.sandbox.rename contract validation", () => {
  it("rejects an empty or whitespace-only label", () => {
    expect(() =>
      agentSandboxRename.input.parse({ sessionId: "sbx_1", label: "" }),
    ).toThrow();
    expect(() =>
      agentSandboxRename.input.parse({ sessionId: "sbx_1", label: "   " }),
    ).toThrow();
  });

  it("rejects a label longer than 80 characters", () => {
    expect(() =>
      agentSandboxRename.input.parse({
        sessionId: "sbx_1",
        label: "a".repeat(81),
      }),
    ).toThrow();
  });

  it("trims surrounding whitespace and accepts an 80-char label", () => {
    const parsed = agentSandboxRename.input.parse({
      sessionId: "sbx_1",
      label: "  hello  ",
    });
    expect(parsed.label).toBe("hello");
    expect(
      agentSandboxRename.input.parse({
        sessionId: "sbx_1",
        label: "a".repeat(80),
      }).label.length,
    ).toBe(80);
  });
});
