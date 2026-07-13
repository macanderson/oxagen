import { describe, it, expect } from "vitest";
import { sandboxTemplateManifestSchema } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import type { SecretKeySummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/environments/actions";
import {
  initialFormState,
  effectiveSlug,
  buildResources,
  buildLiteralEnv,
  buildSecretSelection,
  buildSecretKeys,
  cleanTools,
  cleanPackages,
  buildManifestInput,
  validateManifestInput,
  formatZodErrors,
  type TemplateFormState,
} from "./manifest-form-state";

function makeKey(overrides: Partial<SecretKeySummary> = {}): SecretKeySummary {
  return {
    id: "key-1",
    key: "DATABASE_URL",
    sensitive: true,
    memo: null,
    hasDefault: true,
    overrideEnvironmentIds: [],
    ...overrides,
  };
}

function baseState(
  overrides: Partial<TemplateFormState> = {},
): TemplateFormState {
  return {
    ...initialFormState(),
    name: "SWE-bench runner",
    slugTouched: true,
    slug: "swe-bench-runner",
    ...overrides,
  };
}

describe("manifest-form-state", () => {
  describe("effectiveSlug", () => {
    it("derives the slug from name until the slug is touched", () => {
      expect(
        effectiveSlug({ name: "Base Runner", slug: "", slugTouched: false }),
      ).toBe("base-runner");
    });

    it("uses the typed slug once touched, even if it diverges from the name", () => {
      expect(
        effectiveSlug({
          name: "Base Runner",
          slug: "custom-slug",
          slugTouched: true,
        }),
      ).toBe("custom-slug");
    });
  });

  describe("buildResources / buildLiteralEnv / buildSecretSelection / cleanTools", () => {
    it("only includes resource fields that are positive finite numbers", () => {
      const state = baseState({
        vcpu: "2",
        memoryMb: "",
        timeoutMs: "abc",
        diskMb: "0",
      });
      expect(buildResources(state)).toEqual({ vcpu: 2 });
    });

    it("drops blank-keyed literal env rows and trims the key", () => {
      const state = baseState({
        literalRows: [
          { key: "LOG_LEVEL", value: "info" },
          { key: "  ", value: "ignored" },
        ],
      });
      expect(buildLiteralEnv(state)).toEqual({ LOG_LEVEL: "info" });
    });

    it("builds 'all' or an explicit allow-list depending on secretKind", () => {
      expect(buildSecretSelection(baseState({ secretKind: "all" }))).toBe(
        "all",
      );
      expect(
        buildSecretSelection(
          baseState({ secretKind: "select", selectedKeys: ["key-1"] }),
        ),
      ).toEqual({ keyPublicIds: ["key-1"] });
    });

    it("drops tool rows with an empty ref", () => {
      const state = baseState({
        tools: [
          { kind: "capability", ref: "repo.pr.open" },
          { kind: "tool", ref: "" },
        ],
      });
      expect(cleanTools(state)).toEqual([
        { kind: "capability", ref: "repo.pr.open" },
      ]);
    });
  });

  describe("cleanPackages", () => {
    it("trims names, drops blanks, and drops manager rows left with no names", () => {
      const state = baseState({
        packages: [
          { manager: "pip", names: ["  fastapi  ", "", "pydantic==2.5"] },
          { manager: "npm", names: [] },
          { manager: "apt", names: ["   "] },
        ],
      });
      expect(cleanPackages(state)).toEqual([
        { manager: "pip", names: ["fastapi", "pydantic==2.5"] },
      ]);
    });

    it("returns [] for no packages and preserves manager-row order", () => {
      expect(cleanPackages(baseState())).toEqual([]);
      const state = baseState({
        packages: [
          { manager: "apt", names: ["git"] },
          { manager: "pip", names: ["numpy"] },
        ],
      });
      expect(cleanPackages(state).map((g) => g.manager)).toEqual([
        "apt",
        "pip",
      ]);
    });
  });

  describe("buildSecretKeys — mirrors exportTemplate's resolution", () => {
    const keys = [
      makeKey({
        id: "key-1",
        key: "DATABASE_URL",
        sensitive: true,
        memo: "prod db",
      }),
      makeKey({ id: "key-2", key: "LOG_LEVEL", sensitive: false, memo: null }),
    ];

    it("'all' resolves every workspace key as not-required", () => {
      expect(buildSecretKeys(baseState({ secretKind: "all" }), keys)).toEqual([
        {
          key: "DATABASE_URL",
          sensitive: true,
          memo: "prod db",
          required: false,
        },
        { key: "LOG_LEVEL", sensitive: false, memo: null, required: false },
      ]);
    });

    it("'select' resolves only the selected keys as required", () => {
      expect(
        buildSecretKeys(
          baseState({ secretKind: "select", selectedKeys: ["key-2"] }),
          keys,
        ),
      ).toEqual([
        { key: "LOG_LEVEL", sensitive: false, memo: null, required: true },
      ]);
    });
  });

  describe("buildManifestInput round-trips through sandboxTemplateManifestSchema", () => {
    it("produces a manifest that validates and preserves every form field", () => {
      const state = baseState({
        description: "Runs SWE-bench tasks.",
        provider: "modal",
        runtime: "ghcr.io/oxageninc/oxagen-ci-base:latest",
        vcpu: "2",
        memoryMb: "4096",
        networkMode: "static_egress",
        secretKind: "select",
        selectedKeys: ["key-1"],
        literalRows: [{ key: "LOG_LEVEL", value: "debug" }],
        packages: [{ manager: "pip", names: ["fastapi", "pydantic==2.5"] }],
        tools: [{ kind: "capability", ref: "repo.pr.open" }],
      });
      const keys = [makeKey({ id: "key-1", key: "DATABASE_URL" })];

      const input = buildManifestInput(state, { secretKeys: keys });
      const result = validateManifestInput(input);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a valid manifest");
      expect(result.manifest).toMatchObject({
        kind: "oxagen.sandbox-template",
        version: 1,
        name: "SWE-bench runner",
        slug: "swe-bench-runner",
        description: "Runs SWE-bench tasks.",
        provider: "modal",
        runtime: "ghcr.io/oxageninc/oxagen-ci-base:latest",
        resources: { vcpu: 2, memoryMb: 4096 },
        network: { mode: "static_egress" },
        secretSelection: { keyPublicIds: ["key-1"] },
        literalEnv: { LOG_LEVEL: "debug" },
        packages: [{ manager: "pip", names: ["fastapi", "pydantic==2.5"] }],
        tools: [{ kind: "capability", ref: "repo.pr.open" }],
        secretKeys: [{ key: "DATABASE_URL", required: true }],
      });

      // Also valid against the schema imported directly (belt-and-suspenders —
      // the round trip must hold against the real contract, not just our copy).
      expect(sandboxTemplateManifestSchema.safeParse(input).success).toBe(true);
    });

    it("round-trips a blank template (every optional field omitted) too", () => {
      const state = baseState({ name: "Blank", slug: "blank" });
      const input = buildManifestInput(state, { secretKeys: [] });
      const result = validateManifestInput(input);
      expect(result.ok).toBe(true);
    });
  });

  describe("formatZodErrors / validateManifestInput — readable error formatting", () => {
    it("renders each issue as a dot-path + message, not a raw zod dump", () => {
      const result = validateManifestInput({ kind: "wrong-kind", version: 1 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation to fail");
      expect(result.errors.length).toBeGreaterThan(0);
      for (const e of result.errors) {
        expect(typeof e.path).toBe("string");
        expect(typeof e.message).toBe("string");
      }
      expect(result.errors.some((e) => e.path === "kind")).toBe(true);
    });

    it("uses '(root)' for a document-level issue with no field path", () => {
      const parsed = sandboxTemplateManifestSchema.safeParse("not an object");
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("expected validation to fail");
      const errors = formatZodErrors(parsed.error);
      expect(errors[0]?.path).toBe("(root)");
    });
  });
});
