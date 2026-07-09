/**
 * Sandbox-template value objects + portable manifest v1 (Spec §5.2–§5.3, §19).
 *
 * Single source of truth for every sandbox-template shape. The CRUD contracts
 * (sandbox.template.*), the DB write path, and the export/import round-trip all
 * import from here so a bound is validated in exactly one place.
 *
 * Portability rule (§3): a manifest carries secret key NAMES only, never values.
 * Import upserts the missing secret_keys rows (no value) so the vault grid shows
 * exactly what to fill in; nothing about a template is Oxagen-internal.
 *
 * This module registers NO capability — it is a shared schema module (the
 * naming lint and manifest checker skip it).
 */
import { z } from "zod";

// ── provider ─────────────────────────────────────────────────────────────────
// Extensible set validated here (not a DB enum). Provisioners fail fast on a
// provider whose driver has no credentials configured.
export const sandboxProviderSchema = z.enum(["modal", "vercel", "docker"]);
export type SandboxProvider = z.output<typeof sandboxProviderSchema>;

// ── resources (bounded, §1) ──────────────────────────────────────────────────
// Caps keep a portable manifest from requesting an unbounded sandbox. Every
// field is optional; a driver substitutes its own default for anything unset.
export const sandboxResourcesSchema = z
  .object({
    vcpu: z.number().int().positive().max(4).optional(),
    memoryMb: z.number().int().positive().max(8192).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    diskMb: z.number().int().positive().max(20_480).optional(),
  })
  .strict();
export type SandboxResources = z.output<typeof sandboxResourcesSchema>;

// ── network ──────────────────────────────────────────────────────────────────
// All six modes are valid in the schema; the provisioner fails fast on modes it
// has not yet implemented (aws_privatelink/gcp_psc/reverse_tunnel/ssh_bastion →
// "requires Phase 2/3"). `config` carries mode-specific provisioning detail.
export const sandboxNetworkModeSchema = z.enum([
  "public",
  "static_egress",
  "aws_privatelink",
  "gcp_psc",
  "reverse_tunnel",
  "ssh_bastion",
]);
export type SandboxNetworkMode = z.output<typeof sandboxNetworkModeSchema>;

export const sandboxNetworkSchema = z
  .object({
    mode: sandboxNetworkModeSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SandboxNetwork = z.output<typeof sandboxNetworkSchema>;

// ── secret selection ─────────────────────────────────────────────────────────
// Which vault keys resolve for a run: every live key ('all') or an explicit
// allow-list of key public ids.
export const sandboxSecretSelectionSchema = z.union([
  z.literal("all"),
  z
    .object({ keyPublicIds: z.array(z.string().min(1)) })
    .strict(),
]);
export type SandboxSecretSelection = z.output<typeof sandboxSecretSelectionSchema>;

// ── literal env (non-sensitive) ──────────────────────────────────────────────
// Plain KEY=value config injected at lowest precedence. NEVER secrets.
export const sandboxLiteralEnvSchema = z.record(z.string(), z.string());
export type SandboxLiteralEnv = z.output<typeof sandboxLiteralEnvSchema>;

// ── tools ────────────────────────────────────────────────────────────────────
export const sandboxToolKindSchema = z.enum([
  "capability",
  "mcp_server",
  "agent_skill",
  "tool",
]);
export type SandboxToolKind = z.output<typeof sandboxToolKindSchema>;

export const sandboxTemplateToolSchema = z
  .object({
    kind: sandboxToolKindSchema,
    ref: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SandboxTemplateTool = z.output<typeof sandboxTemplateToolSchema>;

// ── manifest secret key (NAMES only) ─────────────────────────────────────────
// Env-var name pattern mirrors the vault (env-parse SECRET_KEY_PATTERN). No
// value field exists on purpose — a manifest never carries secret material.
export const SECRET_KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const manifestSecretKeySchema = z
  .object({
    key: z.string().regex(SECRET_KEY_NAME_PATTERN, "invalid env-var name"),
    sensitive: z.boolean().default(true),
    memo: z.string().nullable().optional(),
    required: z.boolean().default(false),
  })
  .strict();
export type ManifestSecretKey = z.output<typeof manifestSecretKeySchema>;

// ── manifest v1 ──────────────────────────────────────────────────────────────
export const SANDBOX_TEMPLATE_MANIFEST_KIND = "oxagen.sandbox-template" as const;

export const sandboxTemplateManifestSchema = z
  .object({
    kind: z.literal(SANDBOX_TEMPLATE_MANIFEST_KIND),
    version: z.literal(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().nullable().optional(),
    provider: sandboxProviderSchema.default("modal"),
    runtime: z.string().nullable().optional(),
    resources: sandboxResourcesSchema.default({}),
    network: sandboxNetworkSchema.default({ mode: "public" }),
    secretSelection: sandboxSecretSelectionSchema.default("all"),
    literalEnv: sandboxLiteralEnvSchema.default({}),
    tools: z.array(sandboxTemplateToolSchema).default([]),
    secretKeys: z.array(manifestSecretKeySchema).default([]),
  })
  .strict();
export type SandboxTemplateManifest = z.output<typeof sandboxTemplateManifestSchema>;
export type SandboxTemplateManifestInput = z.input<typeof sandboxTemplateManifestSchema>;
