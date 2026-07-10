/**
 * manifest-field-meta.ts — schema-derived UI metadata for the sandbox-template
 * manifest editor (GUI-discoverability overhaul).
 *
 * Every numeric limit and enum option below is READ AT MODULE LOAD from the
 * single source of truth, packages/oxagen/src/contracts/sandbox-template-manifest.ts,
 * via zod introspection (`schemaMax` / `schemaEnumOptions`). Bumping a cap or
 * adding a provider/network mode there updates every limit and dropdown in
 * this GUI automatically — nothing here hardcodes a number the schema owns.
 *
 * Only the PROSE (labels, help text, provisionability) is hand-authored,
 * because zod carries no human-readable copy. Each hand-authored record is
 * keyed by the schema's own union member type, so TypeScript fails the build
 * the day the schema adds/removes an option and this file isn't updated.
 */
import { z } from "zod";
import {
  sandboxProviderSchema,
  sandboxResourcesSchema,
  sandboxNetworkModeSchema,
  sandboxToolKindSchema,
  type SandboxProvider,
  type SandboxNetworkMode,
  type SandboxToolKind,
} from "@oxagen/oxagen/contracts/sandbox-template-manifest";

// ── zod introspection helpers ─────────────────────────────────────────────────

function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

/** Read a `.max()` numeric bound off a (possibly optional/default-wrapped) zod schema. */
export function schemaMax(schema: z.ZodTypeAny): number {
  const leaf = unwrapZod(schema);
  if (!(leaf instanceof z.ZodNumber) || leaf.maxValue == null) {
    throw new Error("schemaMax: schema has no numeric max() check");
  }
  return leaf.maxValue;
}

/** Read the literal option list off a (possibly optional/default-wrapped) zod enum. */
export function schemaEnumOptions<T extends string>(
  schema: z.ZodTypeAny,
): readonly T[] {
  const leaf = unwrapZod(schema);
  if (!(leaf instanceof z.ZodEnum)) {
    throw new Error("schemaEnumOptions: schema is not a ZodEnum");
  }
  return leaf.options as T[];
}

// ── Resources — limits derived from sandboxResourcesSchema ───────────────────

export const RESOURCE_LIMITS = {
  vcpu: schemaMax(sandboxResourcesSchema.shape.vcpu),
  memoryMb: schemaMax(sandboxResourcesSchema.shape.memoryMb),
  timeoutMs: schemaMax(sandboxResourcesSchema.shape.timeoutMs),
  diskMb: schemaMax(sandboxResourcesSchema.shape.diskMb),
} as const;

export const RESOURCE_FIELD_META: Record<
  keyof typeof RESOURCE_LIMITS,
  { label: string; help: string }
> = {
  vcpu: {
    label: "vCPU",
    help: `Reserved CPU cores, 1–${RESOURCE_LIMITS.vcpu}. Blank uses the provider's default.`,
  },
  memoryMb: {
    label: "Memory MB",
    help: `RAM in MB, 1–${RESOURCE_LIMITS.memoryMb}. Blank uses the provider's default.`,
  },
  timeoutMs: {
    label: "Timeout ms",
    help: `Hard wall-clock limit in ms before the sandbox is killed, 1–${RESOURCE_LIMITS.timeoutMs}. Blank uses the provider's default.`,
  },
  diskMb: {
    label: "Disk MB",
    help: `Ephemeral disk in MB, 1–${RESOURCE_LIMITS.diskMb}. Blank uses the provider's default.`,
  },
};

// ── Providers — options derived from sandboxProviderSchema ───────────────────

export const PROVIDER_OPTIONS = schemaEnumOptions<SandboxProvider>(
  sandboxProviderSchema,
);

/** Vendor-neutral copy: no provider is presented as the "real" or preferred one. */
export const PROVIDER_META: Record<
  SandboxProvider,
  { label: string; help: string }
> = {
  modal: { label: "Modal", help: "Serverless GPU/CPU sandboxes on Modal." },
  vercel: {
    label: "Vercel",
    help: "Vercel Sandbox — ephemeral compute alongside your deployment.",
  },
  docker: {
    label: "Docker",
    help: "Any Docker-compatible runner you operate yourself (self-hosted / BYO infra).",
  },
};

// ── Network modes — options derived from sandboxNetworkModeSchema. Which modes
// are actually provisionable today is a fact about the current provisioner
// implementation, not something the schema encodes, so `provisionable` is
// hand-maintained here — keep it in sync with the provisioner drivers under
// packages/plugins/src/environments/ as they land. ──────────────────────────

export const NETWORK_MODE_OPTIONS = schemaEnumOptions<SandboxNetworkMode>(
  sandboxNetworkModeSchema,
);

export const NETWORK_MODE_META: Record<
  SandboxNetworkMode,
  { label: string; help: string; provisionable: boolean }
> = {
  public: {
    label: "Public egress",
    help: "Default open outbound network access.",
    provisionable: true,
  },
  static_egress: {
    label: "Static egress IP",
    help: "Outbound traffic exits through a stable IP, for allow-listing on a downstream firewall.",
    provisionable: true,
  },
  aws_privatelink: {
    label: "AWS PrivateLink",
    help: "Private connectivity into an AWS VPC endpoint.",
    provisionable: false,
  },
  gcp_psc: {
    label: "GCP Private Service Connect",
    help: "Private connectivity into a GCP service.",
    provisionable: false,
  },
  reverse_tunnel: {
    label: "Reverse tunnel",
    help: "The sandbox dials out to reach a private network you operate.",
    provisionable: false,
  },
  ssh_bastion: {
    label: "SSH bastion",
    help: "Route through an SSH bastion host you control.",
    provisionable: false,
  },
};

// ── Tool kinds — options derived from sandboxToolKindSchema ──────────────────

export const TOOL_KIND_OPTIONS = schemaEnumOptions<SandboxToolKind>(
  sandboxToolKindSchema,
);

export const TOOL_KIND_META: Record<
  SandboxToolKind,
  { label: string; help: string }
> = {
  capability: {
    label: "Capability",
    help: "An Oxagen capability contract name (e.g. repo.pr.open).",
  },
  mcp_server: {
    label: "MCP server",
    help: "A workspace-installed MCP server id.",
  },
  agent_skill: {
    label: "Agent skill",
    help: "A workspace-installed agent skill slug.",
  },
  tool: {
    label: "Tool",
    help: "A raw tool reference not covered by the other kinds.",
  },
};
