import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getCapability } from "../registry";
import { agentGet } from "./agent.get";
import { agentRegister } from "./agent.register";

/** Every object key reachable from a zod schema (the zod 3 `_def` shape this package pins). */
function fieldNames(schema: z.ZodTypeAny, path = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => [
      path ? `${path}.${key}` : key,
      ...fieldNames(child as z.ZodTypeAny, path ? `${path}.${key}` : key),
    ]);
  }
  if (schema instanceof z.ZodArray) return fieldNames(schema.element, path);
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional)
    return fieldNames(schema.unwrap(), path);
  if (schema instanceof z.ZodEffects)
    return fieldNames(schema.innerType(), path);
  if (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodEnum ||
    schema instanceof z.ZodLiteral
  )
    return [];
  throw new Error(`fieldNames: unhandled schema kind at "${path}"`);
}

const SECRET_SHAPED = /secret|hash|key$/i;
/** The ADR-024 agent key `org_ns.ws_ns.slug`: a public name, not a credential. */
const PUBLIC_KEY_FIELDS = new Set(["identity.agentKey"]);

const identity = {
  id: "agt_0123456789abcdefghjkmn",
  slug: "release-bot",
  name: "Release bot",
  description: null,
  agentKey: null,
  harness: "claude-code",
  managed: false,
  principalId: "prn_0123456789abcdefghjkmn",
  operatorId: null,
  status: "unenrolled",
  registeredAt: "2026-09-13T10:00:00.000Z",
  firstFrameAt: null,
  costCenter: null,
};

/** An agent whose active version sets no ceiling. */
const NO_LIMITS = {
  perRun: null,
  perDay: null,
  containmentRequired: false,
  invalid: false,
};

describe("get_agent contract", () => {
  it("is a console read on api, mcp, agent and cli, unmetered, Owner/Admin/Member", () => {
    expect(getCapability("get_agent")).toBe(agentGet);
    expect(agentGet.mutates).toBe(false);
    expect(agentGet.noBillingGate).toBe(true);
    expect(agentGet.scoped).toBe(true);
    expect(agentGet.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
    expect(agentGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "introspection",
    });
    expect(agentGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Member: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("carries no output field named like a secret, a hash or a key", () => {
    const names = fieldNames(agentGet.output);
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((n) => SECRET_SHAPED.test(n) && !PUBLIC_KEY_FIELDS.has(n)),
    ).toEqual([]);
  });

  it("the guard itself catches register_agent's secret", () => {
    expect(
      fieldNames(agentRegister.output).some((n) => SECRET_SHAPED.test(n)),
    ).toBe(true);
  });

  it("takes an id or slug and nothing else", () => {
    expect(agentGet.input.parse({ agentId: "release-bot" })).toEqual({
      agentId: "release-bot",
    });
    expect(agentGet.input.safeParse({}).success).toBe(false);
    expect(agentGet.input.safeParse({ agentId: "" }).success).toBe(false);
    expect(agentGet.input.safeParse({ agentId: "x", slug: "y" }).success).toBe(
      false,
    );
  });

  it("parses an identity with nothing enrolled, no runtime and no versions", () => {
    const out = agentGet.output.parse({
      identity,
      runtime: null,
      toolbelt: null,
      versions: [],
      limits: NO_LIMITS,
      credentials: [],
      roles: [],
      hosts: [],
    });
    expect(out.runtime).toBeNull();
    expect(out.identity.firstFrameAt).toBeNull();
  });

  it("parses the versions a move and a new toolbelt wrote, and refuses a definition (ADR-192)", () => {
    const runtime = {
      id: "rtm_0123abcd",
      name: "Mac's Laptop",
      slug: "macs-laptop",
    };
    const toolbelt = {
      id: "tbt_0123abcd",
      name: "All tools",
      slug: "all-tools",
      kind: "all_tools" as const,
    };
    const base = {
      identity,
      runtime,
      toolbelt,
      limits: NO_LIMITS,
      credentials: [],
      roles: [],
      hosts: [],
    };
    const versions = [
      {
        version: 2,
        changeKind: "runtime_changed" as const,
        runtime,
        toolbelt,
        createdBy: "usr_0123abcd",
        createdAt: "2026-09-25T10:00:00.000Z",
      },
      {
        version: 1,
        changeKind: "registered" as const,
        runtime: null,
        toolbelt,
        createdBy: "usr_0123abcd",
        createdAt: "2026-09-24T10:00:00.000Z",
      },
    ];
    expect(agentGet.output.parse({ ...base, versions }).versions).toEqual(
      versions,
    );
    expect(
      agentGet.output.safeParse({ ...base, versions, definition: null })
        .success,
    ).toBe(false);
  });

  it("carries the active version's ceilings as integer micros with a currency", () => {
    const base = {
      identity,
      runtime: null,
      toolbelt: null,
      versions: [],
      credentials: [],
      roles: [],
      hosts: [],
    };
    const limits = {
      perRun: { micros: "2500000", currency: "USD" },
      perDay: null,
      containmentRequired: true,
      invalid: false,
    };
    expect(agentGet.output.parse({ ...base, limits }).limits).toEqual(limits);
    expect(
      agentGet.output.safeParse({
        ...base,
        limits: { ...limits, perRun: { micros: "2.5", currency: "USD" } },
      }).success,
    ).toBe(false);
    expect(agentGet.output.safeParse(base).success).toBe(false);
  });

  it("lists a revoked credential with its date and a host with null liveness before its first report", () => {
    const out = agentGet.output.parse({
      identity,
      credentials: [
        {
          id: "aky_0123456789abcdefghjkmn",
          name: "agent credential release-bot",
          prefix: "ox_abcdefghi",
          createdAt: "2026-09-13T10:00:00.000Z",
          expiresAt: "2027-03-12T10:00:00.000Z",
          lastUsedAt: null,
          revokedAt: "2026-09-14T10:00:00.000Z",
        },
      ],
      roles: [],
      hosts: [
        {
          hostEnrollmentId: "tch_0123456789abcdefghjkmn",
          hostname: "build-1",
          platform: "linux",
          status: "active",
          mode: "observe",
          harnesses: ["claude-code"],
          deviceKeyFingerprint: "sha256:abc",
          collectorVersion: null,
          hooksOk: null,
          bundleVersionServed: null,
          lastSeenAt: null,
          expiresAt: "2027-03-12T10:00:00.000Z",
          revokedAt: null,
        },
      ],
      runtime: null,
      toolbelt: null,
      versions: [],
      limits: NO_LIMITS,
    });
    expect(out.credentials[0]?.revokedAt).not.toBeNull();
    expect(out.hosts[0]?.hooksOk).toBeNull();
  });
});
