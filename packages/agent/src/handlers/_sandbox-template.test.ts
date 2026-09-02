import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "../test-utils/fixtures";
import type { ResolvedSandboxTemplate } from "@oxagen/plugins";

const h = vi.hoisted(() => ({
  resolveSandboxTemplateForRun:
    vi.fn<
      (
        actor: unknown,
        input: { sandboxTemplateId?: string },
      ) => Promise<ResolvedSandboxTemplate>
    >(),
}));

// Spread the real module so sibling exports the helper needs transitively stay
// intact; only override the resolver we drive.
vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return {
    ...real,
    resolveSandboxTemplateForRun: h.resolveSandboxTemplateForRun,
  };
});

import { driverNetworkForMode, resolveRunTemplate } from "./_sandbox-template";

beforeEach(() => {
  h.resolveSandboxTemplateForRun.mockReset();
});

describe("driverNetworkForMode", () => {
  it("maps public → allow", () => {
    expect(driverNetworkForMode("public")).toBe("allow");
  });

  it("maps static_egress → allow", () => {
    expect(driverNetworkForMode("static_egress")).toBe("allow");
  });

  it.each([
    "aws_privatelink",
    "gcp_psc",
    "reverse_tunnel",
    "ssh_bastion",
  ] as const)(
    "fails fast with a Phase 2/3 error for the unimplemented mode %s",
    (mode) => {
      expect(() => driverNetworkForMode(mode)).toThrow(/Phase 2\/3/);
    },
  );
});

describe("resolveRunTemplate", () => {
  it("returns undefined and does NOT resolve when no templateId is given", async () => {
    const result = await resolveRunTemplate(CTX, undefined);
    expect(result).toBeUndefined();
    expect(h.resolveSandboxTemplateForRun).not.toHaveBeenCalled();
  });

  it("resolves the pinned template by id, forwarding the actor from ctx", async () => {
    const resolved = {
      environment: { id: "env_pub", name: "Prod", slug: "prod" },
      template: { id: "sbx_1", provider: "modal" },
    } as unknown as ResolvedSandboxTemplate;
    h.resolveSandboxTemplateForRun.mockResolvedValue(resolved);

    const result = await resolveRunTemplate(CTX, "sbx_1");

    expect(result).toBe(resolved);
    expect(h.resolveSandboxTemplateForRun).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: CTX.userId },
      { sandboxTemplateId: "sbx_1" },
    );
  });
});
