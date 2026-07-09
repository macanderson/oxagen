import { describe, expect, it } from "vitest";
import { sandboxTemplateCreate } from "./sandbox.template.create";

const template = {
  id: "sbx_1",
  environmentId: "env_1",
  name: "SWE-bench prewarmed",
  slug: "swe-bench-prewarmed",
  description: null,
  isDefault: false,
  isActive: true,
  provider: "modal" as const,
  runtime: "ghcr.io/acme/swe@sha256:abc",
  resources: { vcpu: 2, memoryMb: 4096 },
  network: { mode: "public" as const },
  secretSelection: "all" as const,
  literalEnv: { SWEBENCH_SPLIT: "verified" },
  tools: [{ id: "sbt_1", kind: "capability" as const, ref: "agent.code.execute", config: {} }],
};

describe("sandbox.template.create contract", () => {
  it("registers with the correct name and domain", () => {
    expect(sandboxTemplateCreate.name).toBe("create_sandbox_template");
    expect(sandboxTemplateCreate.domain).toBe("sandbox");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(sandboxTemplateCreate.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("declares the app layer (human-operable UI)", () => {
    expect(sandboxTemplateCreate.layers).toContain("app");
  });
  it("accepts a minimal valid input", () => {
    expect(() =>
      sandboxTemplateCreate.input.parse({
        environmentId: "env_1",
        name: "T",
        slug: "t",
      }),
    ).not.toThrow();
  });
  it("accepts a full valid input with tools and bounded resources", () => {
    expect(() =>
      sandboxTemplateCreate.input.parse({
        environmentId: "env_1",
        name: "T",
        slug: "t",
        provider: "docker",
        runtime: "node:22",
        resources: { vcpu: 4, memoryMb: 8192, timeoutMs: 300000, diskMb: 20480 },
        network: { mode: "static_egress" },
        secretSelection: { keyPublicIds: ["sk_1"] },
        literalEnv: { A: "b" },
        tools: [{ kind: "agent_skill", ref: "swe-bench" }],
        setAsDefault: true,
      }),
    ).not.toThrow();
  });
  it("rejects resources above the bounds", () => {
    expect(() =>
      sandboxTemplateCreate.input.parse({
        environmentId: "env_1",
        name: "T",
        slug: "t",
        resources: { vcpu: 8 },
      }),
    ).toThrow();
  });
  it("rejects input missing the required environmentId", () => {
    expect(() => sandboxTemplateCreate.input.parse({ name: "T", slug: "t" })).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => sandboxTemplateCreate.output.parse({ template })).not.toThrow();
  });
});
