import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// Queue-driven chainable Drizzle tx double: every builder method returns the
// same chain; awaiting it resolves to the next enqueued result (FIFO).
const queue: unknown[] = [];
function enqueue(...results: unknown[]): void {
  queue.push(...results);
}
function makeChain(): unknown {
  let consumed = false;
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (onF: (v: unknown) => unknown) => {
            const value = consumed ? [] : queue.length ? queue.shift() : [];
            consumed = true;
            return Promise.resolve(value).then(onF);
          };
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}
const fakeTx = {
  select: () => makeChain(),
  insert: () => makeChain(),
  update: () => makeChain(),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
  };
});
vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
  };
});

import {
  createTask,
  loadTask,
  updateTask,
  loadContextHistory,
  toA2ATask,
  type A2ATaskRow,
} from "./task-store";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: null,
  apiKeyId: "key_1",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

beforeEach(() => {
  queue.length = 0;
});

describe("toA2ATask", () => {
  const row: A2ATaskRow = {
    id: "00000000-0000-0000-0000-000000000001",
    publicId: "a2a_1",
    contextId: "ctx_1",
    state: "completed",
    messageHistory: [
      {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: "a" }],
        messageId: "m1",
      },
      {
        kind: "message",
        role: "agent",
        parts: [{ kind: "text", text: "b" }],
        messageId: "m2",
      },
    ],
    artifacts: [{ artifactId: "art_1", parts: [{ kind: "text", text: "b" }] }],
    statusMessage: null,
    errorMessage: null,
    updatedAt: new Date("2026-07-04T00:00:00Z"),
  };

  it("maps a row to the A2A Task wire shape", () => {
    const task = toA2ATask(row);
    expect(task.kind).toBe("task");
    expect(task.id).toBe("a2a_1");
    expect(task.contextId).toBe("ctx_1");
    expect(task.status.state).toBe("completed");
    expect(task.status.timestamp).toBe("2026-07-04T00:00:00.000Z");
    expect(task.history).toHaveLength(2);
  });

  it("clamps history to historyLength (keeps the most recent)", () => {
    const task = toA2ATask(row, 1);
    expect(task.history).toHaveLength(1);
    expect(task.history![0]!.messageId).toBe("m2");
  });

  it("surfaces a terminal error into metadata", () => {
    const task = toA2ATask({ ...row, state: "failed", errorMessage: "boom" });
    expect(task.metadata).toEqual({ error: "boom" });
  });

  it("includes the status message when present", () => {
    const statusMessage = {
      kind: "message" as const,
      role: "agent" as const,
      parts: [{ kind: "text" as const, text: "b" }],
      messageId: "m2",
    };
    const task = toA2ATask({ ...row, statusMessage });
    expect(task.status.message).toEqual(statusMessage);
  });

  it("ignores a negative historyLength (returns full history)", () => {
    const task = toA2ATask(row, -1);
    expect(task.history).toHaveLength(2);
  });

  it("returns no history for historyLength 0 (not the whole array)", () => {
    // Regression: `slice(-0)` is `slice(0)`, so a naive slice returned every
    // message for the one value that means "send me none".
    const task = toA2ATask(row, 0);
    expect(task.history).toEqual([]);
  });
});

describe("task store CRUD", () => {
  it("creates a submitted task seeded with the user message", async () => {
    enqueue([
      {
        id: "00000000-0000-0000-0000-0000000000aa",
        publicId: "a2a_new",
        contextId: "ctx_1",
        updatedAt: new Date(),
      },
    ]);
    const row = await createTask(CTX, {
      contextId: "ctx_1",
      userMessage: {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: "hi" }],
        messageId: "m1",
      },
    });
    expect(row.id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(row.publicId).toBe("a2a_new");
    expect(row.state).toBe("submitted");
    expect(row.messageHistory).toHaveLength(1);
  });

  it("returns null when loading an unknown task", async () => {
    enqueue([]);
    const row = await loadTask(CTX, "a2a_missing");
    expect(row).toBeNull();
  });

  it("loads a task and coerces jsonb columns", async () => {
    enqueue([
      {
        id: "00000000-0000-0000-0000-000000000001",
        publicId: "a2a_1",
        contextId: "ctx_1",
        state: "working",
        messageHistory: null,
        artifacts: null,
        statusMessage: null,
        errorMessage: null,
        updatedAt: new Date(),
      },
    ]);
    const row = await loadTask(CTX, "a2a_1");
    expect(row!.messageHistory).toEqual([]);
    expect(row!.artifacts).toEqual([]);
  });

  it("updates state, appends messages, and returns the patched row", async () => {
    enqueue(
      [
        {
          id: "00000000-0000-0000-0000-000000000001",
          publicId: "a2a_1",
          contextId: "ctx_1",
          state: "working",
          messageHistory: [
            {
              kind: "message",
              role: "user",
              parts: [{ kind: "text", text: "a" }],
              messageId: "m1",
            },
          ],
          artifacts: [],
          statusMessage: null,
          errorMessage: null,
        },
      ],
      [{ updatedAt: new Date() }],
    );
    const row = await updateTask(CTX, "a2a_1", {
      state: "completed",
      artifacts: [{ artifactId: "art", parts: [{ kind: "text", text: "b" }] }],
      appendMessages: [
        {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text: "b" }],
          messageId: "m2",
        },
      ],
    });
    expect(row!.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(row!.state).toBe("completed");
    expect(row!.messageHistory).toHaveLength(2);
    expect(row!.artifacts).toHaveLength(1);
  });

  it("threads agentId only when explicitly provided in the patch", async () => {
    enqueue(
      [
        {
          id: "00000000-0000-0000-0000-000000000001",
          publicId: "a2a_1",
          contextId: "ctx_1",
          state: "submitted",
          messageHistory: [],
          artifacts: [],
          statusMessage: null,
          errorMessage: null,
        },
      ],
      [{ updatedAt: new Date() }],
    );
    const row = await updateTask(CTX, "a2a_1", {
      state: "working",
      agentId: "00000000-0000-0000-0000-0000000000ab",
    });
    expect(row!.state).toBe("working");
  });

  it("returns null when updating a missing task", async () => {
    enqueue([]);
    const row = await updateTask(CTX, "a2a_missing", { state: "canceled" });
    expect(row).toBeNull();
  });

  it("flattens message history across a context, restoring oldest → newest from the newest-first query", async () => {
    // The bounded query returns tasks newest-first (desc + limit); the loader
    // must reverse back to chronological order for the model.
    enqueue([
      {
        messageHistory: [
          {
            kind: "message",
            role: "agent",
            parts: [{ kind: "text", text: "b" }],
            messageId: "m2",
          },
        ],
      },
      {
        messageHistory: [
          {
            kind: "message",
            role: "user",
            parts: [{ kind: "text", text: "a" }],
            messageId: "m1",
          },
        ],
      },
    ]);
    const history = await loadContextHistory(CTX, "ctx_1");
    expect(history.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("caps the returned history to the most recent 50 messages", async () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text: `t${i}` }],
      messageId: `m${i}`,
    }));
    enqueue([{ messageHistory: messages }]);
    const history = await loadContextHistory(CTX, "ctx_1");
    expect(history).toHaveLength(50);
    // The TAIL survives (m10..m59) — old messages are trimmed, not new ones.
    expect(history[0]?.messageId).toBe("m10");
    expect(history[49]?.messageId).toBe("m59");
  });
});
