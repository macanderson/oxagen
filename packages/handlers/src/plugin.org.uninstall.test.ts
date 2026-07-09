/**
 * plugin.org.uninstall.test.ts
 *
 * Uninstalling a capability pack must NOT remove sandbox templates it seeded
 * (Spec §6): a template may back a live agent-environment binding, so removal is
 * an explicit user action, never an uninstall side effect. This pins that
 * invariant — the handler deletes only mcp_servers rows, never sandbox_templates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface State {
  deletes: unknown[];
  updates: unknown[];
}
const state: State = { deletes: [], updates: [] };

function makeTx() {
  return {
    update: (table: unknown) => ({
      set: () => {
        state.updates.push(table);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        state.deletes.push(table);
        return Promise.resolve(undefined);
      },
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

import { handler } from "./plugin.org.uninstall";
import { schema } from "@oxagen/database";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

beforeEach(() => {
  state.deletes = [];
  state.updates = [];
});

describe("plugin.org.uninstall", () => {
  it("soft-deletes the listing and deletes mcp servers — never sandbox templates", async () => {
    const result = await handler({ orgListingId: "porg-1" }, ctx as never);

    expect(result).toEqual({ ok: true });
    // The plugin listing is soft-deleted (update), mcp servers hard-deleted.
    expect(state.updates).toContain(schema.pluginInstalledPlugins);
    expect(state.deletes).toContain(schema.mcpServers);
    // Templates are retained.
    expect(state.deletes).not.toContain(schema.sandboxTemplates);
    expect(state.updates).not.toContain(schema.sandboxTemplates);
  });
});
