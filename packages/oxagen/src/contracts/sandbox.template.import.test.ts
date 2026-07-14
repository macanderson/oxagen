import { describe, expect, it } from "vitest";
import { sandboxTemplateImport } from "./sandbox.template.import";

const manifest = {
  kind: "oxagen.sandbox-template" as const,
  version: 1 as const,
  name: "SWE-bench",
  slug: "swe-bench",
  provider: "modal" as const,
  resources: { vcpu: 2 },
  network: { mode: "public" as const },
  secretSelection: "all" as const,
  literalEnv: {},
  tools: [{ kind: "capability" as const, ref: "agent.code.execute" }],
  secretKeys: [{ key: "AI_GATEWAY_API_KEY", sensitive: true, required: true }],
};

describe("sandbox.template.import contract", () => {
  it("registers with the correct name", () => {
    expect(sandboxTemplateImport.name).toBe("import_sandbox_template");
  });
  it("requires environmentId + a valid manifest", () => {
    expect(() =>
      sandboxTemplateImport.input.parse({ environmentId: "env_1", manifest }),
    ).not.toThrow();
    expect(() =>
      sandboxTemplateImport.input.parse({
        environmentId: "env_1",
        manifest,
        slug: "custom",
        setAsDefault: true,
      }),
    ).not.toThrow();
  });
  it("rejects a manifest with the wrong kind", () => {
    expect(() =>
      sandboxTemplateImport.input.parse({
        environmentId: "env_1",
        manifest: { ...manifest, kind: "not-oxagen" },
      }),
    ).toThrow();
  });
  it("outputs the created template plus warnings[]", () => {
    expect(() =>
      sandboxTemplateImport.output.parse({
        template: {
          id: "sbx_1",
          environmentId: "env_1",
          name: "SWE-bench",
          slug: "swe-bench",
          description: null,
          isDefault: false,
          isActive: true,
          provider: "modal",
          runtime: null,
          resources: { vcpu: 2 },
          network: { mode: "public" },
          secretSelection: "all",
          literalEnv: {},
          packages: [],
          tools: [],
        },
        warnings: ['tool "capability:agent.code.execute" ...'],
      }),
    ).not.toThrow();
  });
});
