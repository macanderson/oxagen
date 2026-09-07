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

import { sandboxNetworkModeSchema } from "@oxagen/oxagen/contracts";
import { driverNetworkForMode, resolveRunTemplate } from "./_sandbox-template";

beforeEach(() => {
  h.resolveSandboxTemplateForRun.mockReset();
});

describe("driverNetworkForMode", () => {
  it("maps public → allow", () => {
    expect(driverNetworkForMode("public")).toBe("allow");
  });

  // Replaces "maps static_egress → allow", which asserted the #1410 defect: the
  // one mode that asked for a locked-down network was the one that silently got
  // the same unrestricted egress `public` gets.
  it("refuses static_egress rather than granting public egress (#1410)", () => {
    expect(() => driverNetworkForMode("static_egress")).toThrow(/not enforced/);
    // The refusal has to say what to do next, because an operator hitting it
    // has a template that used to work.
    expect(() => driverNetworkForMode("static_egress")).toThrow(/#2724/);
  });

  it("is the only mode that maps to allow (#1410)", () => {
    // The guard against this becoming a no-op again: any mode added to the
    // allow arm without a provisioner fails here.
    const allowed = sandboxNetworkModeSchema.options.filter((mode) => {
      try {
        return driverNetworkForMode(mode) === "allow";
      } catch {
        return false;
      }
    });
    expect(allowed).toEqual(["public"]);
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
