import { describe, expect, it } from "vitest";
import { sweBenchEvalsManifest } from "./manifest";
import { oxagenPluginManifestSchema } from "../../manifest";
import {
  sandboxTemplateManifestSchema,
  SANDBOX_TEMPLATE_MANIFEST_KIND,
} from "../../../contracts/sandbox-template-manifest";

// A shipped pack that fails validation would break every install that seeds it,
// so this test IMPORTS the embedded pack data and validates it against the same
// zod schemas the install path uses. A bad pack cannot ship.
describe("swe-bench-evals proof pack (Spec §6)", () => {
  it("passes the plugin manifest schema", () => {
    const result = oxagenPluginManifestSchema.safeParse(sweBenchEvalsManifest);
    expect(
      result.success,
      result.success ? "" : JSON.stringify(result.error.issues),
    ).toBe(true);
  });

  it("is a template-distribution pack — claims no capability contract", () => {
    expect(sweBenchEvalsManifest.contracts).toEqual([]);
    expect(sweBenchEvalsManifest.sandboxTemplates?.length).toBeGreaterThan(0);
  });

  it("ships exactly one sandbox template that passes the v1 manifest schema", () => {
    const templates = sweBenchEvalsManifest.sandboxTemplates ?? [];
    expect(templates).toHaveLength(1);
    for (const tpl of templates) {
      const result = sandboxTemplateManifestSchema.safeParse(tpl);
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues),
      ).toBe(true);
    }
  });

  it("declares the SWE-bench prewarmed config the plan requires", () => {
    const tpl = (sweBenchEvalsManifest.sandboxTemplates ?? [])[0]!;
    expect(tpl.kind).toBe(SANDBOX_TEMPLATE_MANIFEST_KIND);
    expect(tpl.version).toBe(1);
    expect(tpl.slug).toBe("swe-bench-prewarmed");
    expect(tpl.provider).toBe("modal");
    expect(tpl.network).toEqual({ mode: "public" });
    expect(tpl.resources).toEqual({
      vcpu: 2,
      memoryMb: 4096,
      timeoutMs: 300_000,
      diskMb: 10_240,
    });
    // Checks the SHAPE of the ref only — that it is digest-pinned rather than
    // tag-pinned, so eval runs are reproducible. It does NOT prove the digest
    // resolves to a published image; the pack currently ships an all-zero
    // placeholder digest (see manifest.ts) that no registry can serve.
    expect(tpl.runtime).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("preloads the code-execution capability and swe-bench skill", () => {
    const tpl = (sweBenchEvalsManifest.sandboxTemplates ?? [])[0]!;
    expect(tpl.tools).toEqual(
      expect.arrayContaining([
        { kind: "capability", ref: "execute_code" },
        { kind: "agent_skill", ref: "swe-bench" },
      ]),
    );
  });

  it("requires the AI_GATEWAY_API_KEY secret by NAME only (never a value)", () => {
    const tpl = (sweBenchEvalsManifest.sandboxTemplates ?? [])[0]!;
    const gatewayKey = tpl.secretKeys.find(
      (k) => k.key === "AI_GATEWAY_API_KEY",
    );
    expect(gatewayKey).toBeDefined();
    expect(gatewayKey?.required).toBe(true);
    expect(gatewayKey?.sensitive).toBe(true);
    // A manifest secret key schema has no `value`/`defaultValue` field at all.
    expect(gatewayKey && "value" in gatewayKey).toBe(false);
    expect(gatewayKey && "defaultValue" in gatewayKey).toBe(false);
  });
});
