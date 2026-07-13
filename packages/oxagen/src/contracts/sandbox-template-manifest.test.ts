import { describe, expect, it } from "vitest";
import {
  sandboxTemplateManifestSchema,
  sandboxResourcesSchema,
  sandboxNetworkSchema,
  sandboxSecretSelectionSchema,
  sandboxTemplatePackageGroupSchema,
  manifestSecretKeySchema,
  SANDBOX_TEMPLATE_MANIFEST_KIND,
} from "./sandbox-template-manifest";

describe("sandbox manifest v1", () => {
  it("applies defaults for provider/resources/network/selection/tools/secretKeys", () => {
    const m = sandboxTemplateManifestSchema.parse({
      kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
      version: 1,
      name: "Bare",
      slug: "bare",
    });
    expect(m.provider).toBe("modal");
    expect(m.resources).toEqual({});
    expect(m.network).toEqual({ mode: "public" });
    expect(m.secretSelection).toBe("all");
    expect(m.literalEnv).toEqual({});
    expect(m.packages).toEqual([]);
    expect(m.tools).toEqual([]);
    expect(m.secretKeys).toEqual([]);
  });

  it("round-trips a fully-specified manifest unchanged", () => {
    const input = {
      kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
      version: 1 as const,
      name: "SWE-bench prewarmed",
      slug: "swe-bench-prewarmed",
      description: "Pre-optimized eval sandbox",
      provider: "modal" as const,
      runtime: "ghcr.io/acme/swe@sha256:abc",
      resources: { vcpu: 2, memoryMb: 4096, timeoutMs: 300000, diskMb: 10240 },
      network: { mode: "public" as const },
      secretSelection: "all" as const,
      literalEnv: { SWEBENCH_SPLIT: "verified" },
      tools: [
        { kind: "capability" as const, ref: "agent.code.execute" },
        { kind: "agent_skill" as const, ref: "swe-bench" },
      ],
      secretKeys: [
        {
          key: "EVAL_API_KEY",
          sensitive: true,
          memo: "provider key",
          required: true,
        },
      ],
    };
    const parsed = sandboxTemplateManifestSchema.parse(input);
    // Re-parsing the parsed value is stable (idempotent round-trip).
    expect(sandboxTemplateManifestSchema.parse(parsed)).toEqual(parsed);
    expect(parsed.tools).toHaveLength(2);
  });

  it("rejects the wrong kind and a non-1 version", () => {
    expect(() =>
      sandboxTemplateManifestSchema.parse({
        kind: "x",
        version: 1,
        name: "n",
        slug: "s",
      }),
    ).toThrow();
    expect(() =>
      sandboxTemplateManifestSchema.parse({
        kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
        version: 2,
        name: "n",
        slug: "s",
      }),
    ).toThrow();
  });

  it("a manifest secret key carries NAMES only — no value field is allowed", () => {
    const k = manifestSecretKeySchema.parse({ key: "API_KEY", required: true });
    expect(k.sensitive).toBe(true); // default
    expect(() => manifestSecretKeySchema.parse({ key: "bad name" })).toThrow();
    // .strict() forbids a smuggled value.
    expect(() =>
      manifestSecretKeySchema.parse({ key: "API_KEY", value: "secret" }),
    ).toThrow();
  });

  it("bounds resources (<=4 vcpu, <=8192 MB, <=300000 ms, <=20480 MB disk)", () => {
    expect(() =>
      sandboxResourcesSchema.parse({ vcpu: 4, memoryMb: 8192 }),
    ).not.toThrow();
    expect(() => sandboxResourcesSchema.parse({ vcpu: 5 })).toThrow();
    expect(() => sandboxResourcesSchema.parse({ memoryMb: 9000 })).toThrow();
    expect(() => sandboxResourcesSchema.parse({ timeoutMs: 400000 })).toThrow();
    expect(() => sandboxResourcesSchema.parse({ diskMb: 30000 })).toThrow();
  });

  it("validates network modes and secret selections", () => {
    expect(() =>
      sandboxNetworkSchema.parse({ mode: "aws_privatelink" }),
    ).not.toThrow();
    expect(() => sandboxNetworkSchema.parse({ mode: "nope" })).toThrow();
    expect(sandboxSecretSelectionSchema.parse("all")).toBe("all");
    expect(() =>
      sandboxSecretSelectionSchema.parse({ keyPublicIds: ["sk_1"] }),
    ).not.toThrow();
  });

  it("defaults packages to [] when the key is omitted", () => {
    const m = sandboxTemplateManifestSchema.parse({
      kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
      version: 1,
      name: "Bare",
      slug: "bare",
    });
    expect(m.packages).toEqual([]);
  });

  it("round-trips a valid packages value unchanged", () => {
    const parsed = sandboxTemplateManifestSchema.parse({
      kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
      version: 1,
      name: "Py",
      slug: "py",
      packages: [{ manager: "pip", names: ["fastapi", "pydantic==2.5"] }],
    });
    expect(parsed.packages).toEqual([
      { manager: "pip", names: ["fastapi", "pydantic==2.5"] },
    ]);
    // Re-parsing the parsed value is stable (idempotent round-trip).
    expect(sandboxTemplateManifestSchema.parse(parsed)).toEqual(parsed);
  });
});

describe("sandbox template package group", () => {
  it("defaults names to [] when omitted", () => {
    const group = sandboxTemplatePackageGroupSchema.parse({ manager: "npm" });
    expect(group.names).toEqual([]);
  });

  it("rejects an unknown package manager", () => {
    expect(() =>
      sandboxTemplatePackageGroupSchema.parse({ manager: "conda", names: [] }),
    ).toThrow();
  });

  it("rejects an empty string in names (min length 1)", () => {
    expect(() =>
      sandboxTemplatePackageGroupSchema.parse({ manager: "npm", names: [""] }),
    ).toThrow();
  });

  it(".strict() rejects an unknown key on a package group", () => {
    expect(() =>
      sandboxTemplatePackageGroupSchema.parse({
        manager: "npm",
        names: ["react"],
        registry: "https://example.com",
      }),
    ).toThrow();
  });
});
