/**
 * `oxagen sandbox template …` — manage portable sandbox templates over the
 * org-scoped /v1 API (Spec §8). Thin shells over the sandbox.template.*
 * capabilities so the CLI stays in parity with the API, MCP, and agent
 * surfaces.
 *
 * Verbs: list (--env filter, --json), get <slug|id> (--json), create
 * (flag-driven config), rm (soft-delete, --yes), set-default, export
 * (-o file.json, stdout default), import (-f manifest.json --env <slug> …,
 * preview-then-`--yes` like `oxagen secret import`).
 *
 * Output discipline (ADR-023 §4, via createOutput): stdout carries only the
 * result (`--json` → one JSON line; pretty → a summary/table); progress and
 * warnings go to stderr; every failure is a uniform `✗ message` (exit 1).
 *
 * Portability rule (§3): a manifest carries secret key NAMES only, never
 * values. `import` previews locally (no API call) and only writes on `--yes`;
 * the server is the authoritative zod validator on commit and returns any
 * warnings[] for uninstalled tool refs or a slug collision.
 */
import { readFileSync, writeFileSync } from "fs";
import { apiPostOrThrow, ApiError, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── shared shapes (mirror sandbox.template.* contract outputs) ───────────────

interface TemplateTool {
  id: string;
  kind: "capability" | "mcp_server" | "agent_skill" | "tool";
  ref: string;
  config: Record<string, unknown>;
}

interface TemplateSummary {
  id: string;
  environmentId: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  provider: string;
  runtime: string | null;
  resources: {
    vcpu?: number;
    memoryMb?: number;
    timeoutMs?: number;
    diskMb?: number;
  };
  network: { mode: string; config?: Record<string, unknown> };
  secretSelection: "all" | { keyPublicIds: string[] };
  literalEnv: Record<string, string>;
  tools: TemplateTool[];
}

interface EnvSummary {
  id: string;
  slug: string;
}

const NETWORK_MODES = [
  "public",
  "static_egress",
  "aws_privatelink",
  "gcp_psc",
  "reverse_tunnel",
  "ssh_bastion",
] as const;

const PROVIDERS = ["modal", "vercel", "docker"] as const;

// ── handle → public-id resolution (apiPostOrThrow so failures render as one
// uniform error line rather than a mid-command process.exit) ─────────────────

async function resolveEnvironmentId(slugOrId: string): Promise<string> {
  if (slugOrId.startsWith("env_")) return slugOrId;
  const { environments } = await apiPostOrThrow<{ environments: EnvSummary[] }>(
    "environment/list",
    {},
  );
  const match = environments.find((e) => e.slug.toLowerCase() === slugOrId.toLowerCase());
  if (!match) throw new ApiError(`No environment with slug '${slugOrId}'.`);
  return match.id;
}

async function resolveTemplateId(slugOrId: string, environmentId?: string): Promise<string> {
  if (slugOrId.startsWith("sbx_")) return slugOrId;
  const { templates } = await apiPostOrThrow<{ templates: TemplateSummary[] }>(
    "sandbox/template/list",
    environmentId ? { environmentId } : {},
  );
  const match = templates.find((t) => t.slug.toLowerCase() === slugOrId.toLowerCase());
  if (!match) throw new ApiError(`No sandbox template with slug '${slugOrId}'.`);
  return match.id;
}

// ── list ─────────────────────────────────────────────────────────────────────

export async function handleTemplateList(
  opts: { env?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  try {
    const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : undefined;
    const { templates } = await apiPostOrThrow<{ templates: TemplateSummary[] }>(
      "sandbox/template/list",
      environmentId ? { environmentId } : {},
    );
    out.data(templates, () =>
      renderTemplateTable(templates),
    );
  } catch (err) {
    out.error(err, "api");
  }
}

function renderTemplateTable(templates: TemplateSummary[]): string {
  if (templates.length === 0) return "(no templates)";
  const rows = templates.map((t) => [
    t.name,
    t.slug,
    t.provider,
    t.isDefault ? "★" : "",
    t.isActive ? "yes" : "no",
    String(t.tools.length),
    t.id,
  ]);
  return captureTable(["NAME", "SLUG", "PROVIDER", "DEFAULT", "ACTIVE", "TOOLS", "ID"], rows);
}

// ── get ──────────────────────────────────────────────────────────────────────

export async function handleTemplateGet(
  slugOrId: string,
  opts: { env?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  try {
    const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : undefined;
    const templateId = await resolveTemplateId(slugOrId, environmentId);
    const { template } = await apiPostOrThrow<{ template: TemplateSummary }>(
      "sandbox/template/get",
      { templateId },
    );
    out.data(template, () => renderTemplateDetail(template));
  } catch (err) {
    out.error(err, "api");
  }
}

function renderTemplateDetail(t: TemplateSummary): string {
  const lines = [
    `${t.name} (${t.slug})${t.isDefault ? " ★ default" : ""}${t.isActive ? "" : " · inactive"}`,
    `  id:        ${t.id}`,
    `  provider:  ${t.provider}`,
    `  runtime:   ${t.runtime ?? "‹driver default›"}`,
    `  network:   ${t.network.mode}`,
    `  secrets:   ${t.secretSelection === "all" ? "all live keys" : `${t.secretSelection.keyPublicIds.length} selected`}`,
  ];
  if (t.description) lines.push(`  ${t.description}`);
  const res = t.resources;
  const resParts = [
    res.vcpu !== undefined ? `${res.vcpu} vCPU` : null,
    res.memoryMb !== undefined ? `${res.memoryMb} MiB` : null,
    res.timeoutMs !== undefined ? `${res.timeoutMs} ms` : null,
    res.diskMb !== undefined ? `${res.diskMb} MiB disk` : null,
  ].filter((v): v is string => v !== null);
  lines.push(`  resources: ${resParts.length ? resParts.join(", ") : "‹driver defaults›"}`);
  const literalKeys = Object.keys(t.literalEnv);
  if (literalKeys.length) lines.push(`  literalEnv: ${literalKeys.join(", ")}`);
  if (t.tools.length) {
    lines.push(`  tools:`);
    for (const tool of t.tools) lines.push(`    - ${tool.kind}:${tool.ref}`);
  }
  return lines.join("\n");
}

// ── create ─────────────────────────────────────────────────────────────────

export async function handleTemplateCreate(
  opts: {
    env?: string;
    name?: string;
    slug?: string;
    description?: string;
    provider?: string;
    runtime?: string;
    vcpu?: string;
    memoryMb?: string;
    timeoutMs?: string;
    diskMb?: string;
    networkMode?: string;
    envVar?: string[];
    setDefault?: boolean;
    json?: boolean;
  },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (!opts.env) return usageError(out, "create requires --env <environment slug|id>.");
  if (!opts.name) return usageError(out, "create requires --name <name>.");
  if (!opts.slug) return usageError(out, "create requires --slug <slug>.");
  if (opts.provider && !PROVIDERS.includes(opts.provider as (typeof PROVIDERS)[number])) {
    return usageError(out, `Invalid --provider "${opts.provider}". Use one of: ${PROVIDERS.join(", ")}.`);
  }
  if (
    opts.networkMode &&
    !NETWORK_MODES.includes(opts.networkMode as (typeof NETWORK_MODES)[number])
  ) {
    return usageError(
      out,
      `Invalid --network-mode "${opts.networkMode}". Use one of: ${NETWORK_MODES.join(", ")}.`,
    );
  }

  let literalEnv: Record<string, string> | undefined;
  if (opts.envVar && opts.envVar.length) {
    literalEnv = {};
    for (const pair of opts.envVar) {
      const eq = pair.indexOf("=");
      if (eq <= 0) return usageError(out, `Invalid --env-var "${pair}". Expected KEY=value.`);
      literalEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  const resources: Record<string, number> = {};
  const numeric = parseNumericResources(opts, out);
  if (numeric === null) return; // usage error already emitted
  Object.assign(resources, numeric);

  try {
    const environmentId = await resolveEnvironmentId(opts.env);
    const body: Record<string, unknown> = {
      environmentId,
      name: opts.name,
      slug: opts.slug,
    };
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.provider) body.provider = opts.provider;
    if (opts.runtime !== undefined) body.runtime = opts.runtime;
    if (Object.keys(resources).length) body.resources = resources;
    if (opts.networkMode) body.network = { mode: opts.networkMode };
    if (literalEnv) body.literalEnv = literalEnv;
    if (opts.setDefault) body.setAsDefault = true;

    const { template } = await apiPostOrThrow<{ template: TemplateSummary }>(
      "sandbox/template/create",
      body,
    );
    out.data(template, () =>
      `✓ created template ${template.name} (${template.slug}) ${template.id}${template.isDefault ? " ★ default" : ""}`,
    );
  } catch (err) {
    out.error(err, "api");
  }
}

/** Parse the four numeric resource flags; emit a usage error + return null on a bad value. */
function parseNumericResources(
  opts: { vcpu?: string; memoryMb?: string; timeoutMs?: string; diskMb?: string },
  out: ReturnType<typeof createOutput>,
): Record<string, number> | null {
  const spec: Array<[keyof typeof opts, string, string]> = [
    ["vcpu", "vcpu", "--vcpu"],
    ["memoryMb", "memoryMb", "--memory-mb"],
    ["timeoutMs", "timeoutMs", "--timeout-ms"],
    ["diskMb", "diskMb", "--disk-mb"],
  ];
  const parsed: Record<string, number> = {};
  for (const [key, field, flag] of spec) {
    const raw = opts[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      out.error(`Invalid ${flag} "${raw}". Expected a positive integer.`, "usage");
      process.exitCode = 2;
      return null;
    }
    parsed[field] = n;
  }
  return parsed;
}

// ── rm ─────────────────────────────────────────────────────────────────────

export async function handleTemplateRemove(
  slugOrId: string,
  opts: { env?: string; yes?: boolean; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (!opts.yes) {
    out.info(`This soft-deletes template '${slugOrId}'. Rerun with --yes to confirm.`);
    return;
  }
  try {
    const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : undefined;
    const templateId = await resolveTemplateId(slugOrId, environmentId);
    const res = await apiPostOrThrow<{ ok: boolean }>("sandbox/template/delete", { templateId });
    out.data(res, () => `✓ removed template ${slugOrId}`);
  } catch (err) {
    out.error(err, "api");
  }
}

// ── set-default ──────────────────────────────────────────────────────────────

export async function handleTemplateSetDefault(
  slugOrId: string,
  opts: { env?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  try {
    const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : undefined;
    const templateId = await resolveTemplateId(slugOrId, environmentId);
    const { template } = await apiPostOrThrow<{ template: TemplateSummary }>(
      "sandbox/template/set-default",
      { templateId },
    );
    out.data(template, () => `✓ default template: ${template.name} (${template.slug})`);
  } catch (err) {
    out.error(err, "api");
  }
}

// ── export ─────────────────────────────────────────────────────────────────

export async function handleTemplateExport(
  slugOrId: string,
  opts: { env?: string; out?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  try {
    const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : undefined;
    const templateId = await resolveTemplateId(slugOrId, environmentId);
    const { manifest } = await apiPostOrThrow<{ manifest: unknown }>(
      "sandbox/template/export",
      { templateId },
    );
    const serialized = JSON.stringify(manifest, null, 2);
    if (opts.out) {
      writeFileSync(opts.out, serialized + "\n", "utf8");
      out.info(`✓ wrote manifest to ${opts.out}`);
      // The result on stdout stays the manifest so `--json` piping is uniform.
      out.data(manifest, () => `✓ wrote manifest to ${opts.out}`);
      return;
    }
    // No -o: the manifest IS the result — print it to stdout (portable artifact).
    out.data(manifest, () => serialized);
  } catch (err) {
    out.error(err, "api");
  }
}

// ── import (preview-then-`--yes`, mirroring `oxagen secret import`) ──────────

interface ManifestPreview {
  kind?: unknown;
  version?: unknown;
  name?: unknown;
  slug?: unknown;
  provider?: unknown;
  description?: unknown;
  tools?: Array<{ kind?: unknown; ref?: unknown }>;
  secretKeys?: Array<{ key?: unknown; required?: unknown; sensitive?: unknown }>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleTemplateImport(
  opts: { env?: string; file?: string; slug?: string; setDefault?: boolean; yes?: boolean; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (!opts.env) return usageError(out, "import requires --env <environment slug|id>.");

  let raw: string;
  try {
    raw = opts.file ? readFileSync(opts.file, "utf8") : await readStdin();
  } catch (err) {
    out.error(err, "io");
    return;
  }

  let manifest: ManifestPreview & Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as ManifestPreview & Record<string, unknown>;
  } catch {
    return usageError(out, "Manifest is not valid JSON.");
  }

  // Local preview + structural warnings — never a substitute for the server's
  // zod validation on commit, just an at-a-glance summary before writing.
  const warnings = previewWarnings(manifest, opts.slug);
  const effectiveSlug = opts.slug ?? String(manifest.slug ?? "");
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const secretKeys = Array.isArray(manifest.secretKeys) ? manifest.secretKeys : [];

  if (!opts.yes) {
    // Preview: nothing reaches the server. Emit the summary + warnings, then stop.
    const summary = {
      action: "preview" as const,
      name: manifest.name ?? null,
      slug: effectiveSlug || null,
      provider: manifest.provider ?? "modal",
      environment: opts.env,
      setAsDefault: !!opts.setDefault,
      tools: tools.map((t) => `${String(t.kind)}:${String(t.ref)}`),
      secretKeys: secretKeys.map((k) => String(k.key)),
      warnings,
    };
    out.data(summary, () => renderImportPreview(summary));
    return;
  }

  try {
    const environmentId = await resolveEnvironmentId(opts.env);
    const body: Record<string, unknown> = { environmentId, manifest };
    if (opts.slug) body.slug = opts.slug;
    if (opts.setDefault) body.setAsDefault = true;
    const res = await apiPostOrThrow<{ template: TemplateSummary; warnings: string[] }>(
      "sandbox/template/import",
      body,
    );
    out.data(res, () => {
      const head = `✓ imported template ${res.template.name} (${res.template.slug}) ${res.template.id}${res.template.isDefault ? " ★ default" : ""}`;
      const warnLines = res.warnings.map((w) => `  ⚠ ${w}`);
      return [head, ...warnLines].join("\n");
    });
  } catch (err) {
    out.error(err, "api");
  }
}

function previewWarnings(manifest: ManifestPreview, slugOverride?: string): string[] {
  const warnings: string[] = [];
  if (manifest.kind !== "oxagen.sandbox-template") {
    warnings.push(`unexpected manifest kind '${String(manifest.kind)}' (expected 'oxagen.sandbox-template')`);
  }
  if (manifest.version !== 1) {
    warnings.push(`unexpected manifest version '${String(manifest.version)}' (expected 1)`);
  }
  if (!manifest.name) warnings.push("manifest is missing 'name'");
  if (!slugOverride && !manifest.slug) warnings.push("manifest is missing 'slug' (pass --slug to override)");
  const secretKeys = Array.isArray(manifest.secretKeys) ? manifest.secretKeys : [];
  const required = secretKeys.filter((k) => k.required).map((k) => String(k.key));
  if (required.length) {
    warnings.push(
      `required secret key(s) will be created empty — fill them before provisioning: ${required.join(", ")}`,
    );
  }
  return warnings;
}

function renderImportPreview(summary: {
  name: unknown;
  slug: string | null;
  provider: unknown;
  environment: string;
  setAsDefault: boolean;
  tools: string[];
  secretKeys: string[];
  warnings: string[];
}): string {
  const lines = [
    `preview — import into environment '${summary.environment}':`,
    `  name:      ${String(summary.name ?? "‹missing›")}`,
    `  slug:      ${summary.slug ?? "‹missing›"}`,
    `  provider:  ${String(summary.provider)}`,
    `  default:   ${summary.setAsDefault ? "yes" : "no"}`,
  ];
  if (summary.tools.length) lines.push(`  tools:     ${summary.tools.join(", ")}`);
  if (summary.secretKeys.length) lines.push(`  secrets:   ${summary.secretKeys.join(", ")}`);
  for (const w of summary.warnings) lines.push(`  ⚠ ${w}`);
  lines.push("rerun with --yes to import");
  return lines.join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────────────

function usageError(out: ReturnType<typeof createOutput>, message: string): void {
  process.exitCode = 2;
  out.error(message, "usage");
}

/** Render an aligned table to a string (createOutput.data owns the write). */
function captureTable(headers: string[], rows: string[][]): string {
  const lines: string[] = [];
  printTable(headers, rows, { write: (l) => void lines.push(l), writeErr: () => {} });
  return lines.join("\n");
}
