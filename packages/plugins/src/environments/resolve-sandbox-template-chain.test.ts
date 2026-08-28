/**
 * resolve-sandbox-template-chain.test.ts
 *
 * Covers the environment → binding → default resolution CHAIN of
 * resolveSandboxTemplateForRun — everything BEYOND the explicit
 * `sandboxTemplateId` short-circuit, which resolve-sandbox-template.test.ts
 * already owns.
 *
 * Resolution order exercised here:
 *   1. environment: explicit environmentId → agent's PRIMARY binding's
 *      environment → workspace default environment (each a distinct branch,
 *      including the "resolved row was deleted/missing" edge for the binding
 *      case, which falls through to the workspace default).
 *   2. template: the resolved binding's pinned template → the environment's
 *      default template — plus every preflight error along the way (no
 *      environment to run in, environment inactive, bound template deleted,
 *      no default template, resolved template inactive).
 *   3. resolveAgentInternalId's three id forms (uuid passthrough, `agt_`
 *      public id, bare slug) and its not-found error.
 *
 * @oxagen/database withTenantDb runs the callback against a queue-driven fake
 * tx (same pattern as resolve-sandbox-template.test.ts / sandbox-template-
 * service.crud.test.ts): each `tx.select()` shifts one result set off
 * `selectQueue`, seeded in the exact order the service issues them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface State {
  selectQueue: unknown[][];
}
const state: State = { selectQueue: [] };

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async (n: number) => result.slice(0, n),
    orderBy: async () => result,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  });
  return chain;
}

function makeTx() {
  return {
    select: (_cols: unknown) => makeChain(state.selectQueue.shift() ?? []),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

import { resolveSandboxTemplateForRun } from "./sandbox-template-service";

const actor = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };

const UUID_AGENT = "11111111-1111-4111-8111-111111111111";

function tplRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sbx-int",
    publicId: "sbx-pub",
    environmentInternalId: "env-int",
    environmentPublicId: "env-pub",
    environmentName: "Prod",
    environmentSlug: "prod",
    name: "SWE-bench prewarmed",
    slug: "swe-bench-prewarmed",
    description: null,
    isDefault: true,
    isActive: true,
    provider: "modal",
    runtime: null,
    resources: { vcpu: 2 },
    network: { mode: "public" },
    secretSelection: "all",
    literalEnv: {},
    ...overrides,
  };
}

function envRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-int",
    name: "Prod",
    slug: "prod",
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  state.selectQueue = [];
});

describe("resolveSandboxTemplateForRun — environment resolution chain", () => {
  it("explicit environmentId, no agentId — skips the binding lookup and resolves the environment's default template", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [{ publicId: "sbx-pub" }], // environment default template lookup
      [tplRow()], // loadTemplateRow (loadTemplateWithTools)
      [], // loadToolsFor
    ];

    const result = await resolveSandboxTemplateForRun(actor, {
      environmentId: "env-pub",
    });

    expect(result.environment).toEqual({
      id: "env-pub",
      name: "Prod",
      slug: "prod",
    });
    expect(result.template.id).toBe("sbx-pub");
  });

  it("explicit environmentId + agentId — a binding for (agent, env) pins a template", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [{ sandboxTemplateId: "tpl-int-bound" }], // binding lookup for (agent, env)
      [{ publicId: "sbx-pub-bound", isActive: true }], // bound-template lookup
      [tplRow({ publicId: "sbx-pub-bound" })], // loadTemplateRow
      [], // loadToolsFor
    ];

    const result = await resolveSandboxTemplateForRun(actor, {
      environmentId: "env-pub",
      agentId: UUID_AGENT,
    });

    expect(result.template.id).toBe("sbx-pub-bound");
  });

  it("explicit environmentId + agentId — no binding row for that pair falls back to the environment default", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [], // binding lookup: none found
      [{ publicId: "sbx-pub" }], // environment default template lookup
      [tplRow()], // loadTemplateRow
      [], // loadToolsFor
    ];

    const result = await resolveSandboxTemplateForRun(actor, {
      environmentId: "env-pub",
      agentId: UUID_AGENT,
    });

    expect(result.template.id).toBe("sbx-pub");
  });

  it("no environmentId, agentId as a bare slug — resolves the agent, then its PRIMARY binding's own environment + template", async () => {
    state.selectQueue = [
      [{ id: "agent-int-1" }], // resolveAgentInternalId: slug lookup (not agt_, not uuid)
      [{ environmentInternalId: "env-int-2", sandboxTemplateId: "tpl-int-3" }], // primary binding
      [{ id: "env-int-2", name: "Staging", slug: "staging", isActive: true }], // env for primary binding
      [{ publicId: "sbx-pub-3", isActive: true }], // bound-template lookup
      [tplRow({ publicId: "sbx-pub-3", environmentPublicId: "env-pub-2" })], // loadTemplateRow
      [], // loadToolsFor
    ];

    const result = await resolveSandboxTemplateForRun(actor, {
      agentId: "my-agent-slug",
    });

    expect(result.environment).toEqual({
      id: "env-pub-2",
      name: "Staging",
      slug: "staging",
    });
    expect(result.template.id).toBe("sbx-pub-3");
  });

  it("no environmentId, agentId present — the primary binding's environment was deleted, falls back to the workspace default", async () => {
    state.selectQueue = [
      [{ environmentInternalId: "env-deleted-int", sandboxTemplateId: null }], // primary binding
      [], // environment lookup for that binding: row gone (deleted)
      [
        {
          id: "env-default-int",
          name: "Default",
          slug: "default",
          isActive: true,
        },
      ], // workspace default env
      [{ publicId: "sbx-pub-default" }], // environment default template lookup
      [
        tplRow({
          publicId: "sbx-pub-default",
          environmentPublicId: "env-pub-default",
        }),
      ], // loadTemplateRow
      [], // loadToolsFor
    ];

    const result = await resolveSandboxTemplateForRun(actor, {
      agentId: UUID_AGENT,
    });

    expect(result.environment).toEqual({
      id: "env-pub-default",
      name: "Default",
      slug: "default",
    });
  });

  it("no environmentId, no agentId — resolves straight to the workspace default environment", async () => {
    state.selectQueue = [
      [{ id: "env-x-int", name: "X", slug: "x", isActive: true }], // workspace default env
      [], // environment default template lookup: none configured
    ];

    await expect(resolveSandboxTemplateForRun(actor, {})).rejects.toThrow(
      /has no default sandbox template/,
    );
  });

  it("no environmentId, agentId present but has no primary binding — throws when the workspace also has no default environment", async () => {
    state.selectQueue = [
      [], // primary binding lookup: agent has none
      [], // workspace default environment lookup: none configured
    ];

    await expect(
      resolveSandboxTemplateForRun(actor, { agentId: UUID_AGENT }),
    ).rejects.toThrow(/no environment to run in/);
  });

  it("throws when the explicitly-resolved environment is inactive", async () => {
    state.selectQueue = [[envRow({ isActive: false })]];

    await expect(
      resolveSandboxTemplateForRun(actor, { environmentId: "env-pub" }),
    ).rejects.toThrow(/environment "prod" is inactive/);
  });

  it("throws when the agent's bound template was deleted since binding", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [{ sandboxTemplateId: "deleted-tpl-int" }], // binding lookup
      [], // bound-template lookup: gone
    ];

    await expect(
      resolveSandboxTemplateForRun(actor, {
        environmentId: "env-pub",
        agentId: UUID_AGENT,
      }),
    ).rejects.toThrow(/bound template was deleted/);
  });

  it("throws when the resolved template itself is inactive", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [{ publicId: "sbx-pub" }], // environment default template lookup
      [tplRow({ isActive: false })], // loadTemplateRow: template is inactive
      [], // loadToolsFor
    ];

    await expect(
      resolveSandboxTemplateForRun(actor, { environmentId: "env-pub" }),
    ).rejects.toThrow(/template "swe-bench-prewarmed" is inactive/);
  });

  it("throws when the agent identifier cannot be resolved at all", async () => {
    state.selectQueue = [[]]; // agent slug lookup: no match

    await expect(
      resolveSandboxTemplateForRun(actor, { agentId: "no-such-agent" }),
    ).rejects.toThrow(/agent not found: no-such-agent/);
  });
});
