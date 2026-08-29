import type { OxagenPluginManifest } from "../../manifest";
import { SANDBOX_TEMPLATE_MANIFEST_KIND } from "../../../contracts/sandbox-template-manifest";

// ── First-party proof pack: portable SWE-bench eval sandbox (Spec §6) ─────────
//
// This pack is the differentiator's proof: a third party building on Oxagen
// (here, us) ships a PRE-OPTIMIZED sandbox config as embedded manifest data and
// runs evals on it with ZERO platform code. It claims no capability contract —
// its entire payload is the portable sandbox template below, seeded into the
// installing workspace's default environment on install (idempotent by slug).
//
// Embedded module data, NOT a runtime fs path: the manifest is a plain object
// compiled into the bundle, so distribution never depends on a file being
// present on disk at runtime.
export const sweBenchEvalsManifest: OxagenPluginManifest = {
  id: "oxagen/swe-bench-evals",
  name: "SWE-bench Evals",
  description:
    "A pre-optimized, portable sandbox for running SWE-bench-style code evaluations — prewarmed toolchain image, bounded resources, and the code-execution + swe-bench tools preloaded.",
  version: "1.0.0",
  pluginType: "agent_capability",
  tier: "free",
  visibility: "beta",
  category: "evals",
  icon: "flask-conical",
  color: "#8b5cf6",
  // Template-distribution pack: no capability contract is claimed (claiming a
  // builtin like `execute_code` would wrongly gate it behind install).
  contracts: [],
  scopes: [],
  sandboxTemplates: [
    {
      kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
      version: 1,
      name: "SWE-bench prewarmed",
      slug: "swe-bench-prewarmed",
      description:
        "Pre-optimized eval sandbox: prewarmed Node + repo toolchain, digest-pinned for reproducible evals.",
      provider: "modal",
      // Placeholder digest-pinned image ref — replace with the published
      // prewarmed image (e.g. the OXAGEN_PREWARMED SWE-bench image) once it is
      // pushed to a registry. Digest-pinning keeps eval runs reproducible.
      runtime:
        "ghcr.io/oxageninc/swe-bench-prewarmed@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      resources: {
        vcpu: 2,
        memoryMb: 4096,
        timeoutMs: 300_000,
        diskMb: 10_240,
      },
      network: { mode: "public" },
      secretSelection: "all",
      literalEnv: {},
      // Toolchain is baked into the digest-pinned prewarmed image, so no
      // provision-time package installs are needed.
      packages: [],
      tools: [
        // Post-ADR-025 capability name for code execution (was agent.code.execute).
        { kind: "capability", ref: "execute_code" },
        { kind: "agent_skill", ref: "swe-bench" },
      ],
      secretKeys: [
        {
          key: "AI_GATEWAY_API_KEY",
          sensitive: true,
          required: true,
          memo: "gateway key for the eval judge",
        },
      ],
    },
  ],
};
