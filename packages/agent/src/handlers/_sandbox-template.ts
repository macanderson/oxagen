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
 * `public` is the only mode with a provisioner. Every other mode FAILS FAST
 * here, before any sandbox is created, rather than silently degrading to public
 * egress — which is a security regression for a template that asked for a
 * locked-down network.
 *
 * `static_egress` was the exception and is why #1410 was filed. It mapped to
 * `allow`, identical to `public`, and the comment here claimed its IP was
 * "recorded for telemetry but not yet enforced at the driver". Nothing recorded
 * it: no code in this repository reads, pins, allocates or asserts an egress
 * address. The mode was accepted by the API, stored in the database, and did
 * nothing.
 *
 * A static-egress guarantee is worth something only on the receiving side — a
 * customer allowlists the pinned address on their database, VPN or partner API.
 * If the sandbox egresses from arbitrary addresses instead, either that
 * allowlist blocks the agent, which reads as an agent bug, or the allowlist is
 * wide enough not to notice and the customer is running with a control they
 * believe they have. Refusing says so; returning `allow` did not.
 *
 * Pinning it for real is the follow-up (#2724). Until then this is the honest
 * answer, and it is the same one its four siblings already gave.
 *
 * Refusing stops the next run from degrading silently; it does not tell the
 * owner of a template that already had it that the mode was never enforced.
 * `tools/scripts/find-static-egress-templates.ts` names those rows, which is
 * the half that matters to somebody who allowlisted an address on the other
 * end and has been trusting a control they did not have.
 */
export function driverNetworkForMode(
  mode: SandboxNetworkMode,
): "allow" | "deny" {
  switch (mode) {
    case "public":
      return "allow";
    case "static_egress":
      throw new Error(
        '[sandbox-template] network mode "static_egress" is not enforced — no ' +
          "egress address is pinned, so the sandbox would get the same " +
          "unrestricted public egress a public template gets. Choose a public " +
          "template if that is acceptable, or wait for egress pinning (#2724).",
      );
    case "aws_privatelink":
    case "gcp_psc":
    case "reverse_tunnel":
    case "ssh_bastion":
      throw new Error(
        `[sandbox-template] network mode "${mode}" requires Phase 2/3 and is not yet ` +
          "provisionable — remove it or choose a public template",
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
