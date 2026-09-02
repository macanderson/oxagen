// Shared sandbox-template provisioning helpers (Spec §5, §11/§12).
//
// A sandbox template is a portable, versioned config (provider, custom image,
// resources, network mode, vault secret selection + literal env). The run
// handlers (agent.code.execute, agent.sandbox.start) resolve a template here and
// map its rich shape onto the driver-level SandboxRequest / SandboxSessionSpec.
import {
  resolveSandboxTemplateForRun,
  type ResolvedSandboxTemplate,
} from "@oxagen/plugins";
import type { SandboxNetworkMode } from "@oxagen/oxagen/contracts";
import type { CapabilityContext } from "../types";

/**
 * Map a template's rich network mode onto the driver's binary allow/deny flag.
 *
 * `public` and `static_egress` both permit egress today (static-egress IP
 * pinning is recorded for telemetry but not yet enforced at the driver). The
 * private-connectivity modes have no provisioner yet, so they FAIL FAST here —
 * before any sandbox is created — rather than silently degrading to public
 * egress, which would be a security regression for a template that asked for a
 * locked-down network.
 */
export function driverNetworkForMode(
  mode: SandboxNetworkMode,
): "allow" | "deny" {
  switch (mode) {
    case "public":
    case "static_egress":
      return "allow";
    case "aws_privatelink":
    case "gcp_psc":
    case "reverse_tunnel":
    case "ssh_bastion":
      throw new Error(
        `[sandbox-template] network mode "${mode}" requires Phase 2/3 and is not yet ` +
          "provisionable — remove it or choose a public/static_egress template",
      );
  }
}

/**
 * Resolve the template a run should use, or `undefined` when the caller named
 * none (preserving the historical no-template behavior of agent.code.execute /
 * agent.sandbox.start). Resolution is opt-in via `sandboxTemplateId`; the
 * service validates the template + its environment are active.
 */
export async function resolveRunTemplate(
  ctx: CapabilityContext,
  sandboxTemplateId: string | undefined,
): Promise<ResolvedSandboxTemplate | undefined> {
  if (!sandboxTemplateId) return undefined;
  return resolveSandboxTemplateForRun(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { sandboxTemplateId },
  );
}
