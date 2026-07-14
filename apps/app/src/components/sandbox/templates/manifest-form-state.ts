/**
 * manifest-form-state.ts — pure form-state <-> manifest v1 conversion for the
 * sandbox-template editor. No React here: this is the seam the editor's live
 * "Manifest" preview, the round-trip tests, and (indirectly) the create/edit
 * submit handlers all share, so there is exactly one place that knows how a
 * TemplateDialog's fields become a `sandboxTemplateManifestSchema` document.
 */
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
  SANDBOX_TEMPLATE_MANIFEST_KIND,
  sandboxTemplateManifestSchema,
  type SandboxLiteralEnv,
  type SandboxNetworkMode,
  type SandboxProvider,
  type SandboxResources,
  type SandboxSecretSelection,
  type SandboxTemplateManifest,
  type SandboxTemplateManifestInput,
  type SandboxTemplatePackageGroup,
  type SandboxTemplatePackages,
  type SandboxTemplateTool,
  type ManifestSecretKey,
} from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import type { SandboxTemplateSummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/sandboxes/sandbox-template-actions";
import type { SecretKeySummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/environments/actions";

export type SecretSelectionKind = "all" | "select";

export interface LiteralEnvRow {
  key: string;
  value: string;
}

export interface TemplateFormState {
  name: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  provider: SandboxProvider;
  runtime: string;
  vcpu: string;
  memoryMb: string;
  timeoutMs: string;
  diskMb: string;
  networkMode: SandboxNetworkMode;
  secretKind: SecretSelectionKind;
  selectedKeys: string[];
  literalRows: LiteralEnvRow[];
  packages: SandboxTemplatePackageGroup[];
  tools: SandboxTemplateTool[];
}

function numStr(n: number | undefined): string {
  return n === undefined || n === null ? "" : String(n);
}

/** Seed a form state from an existing template (edit mode) or blank (create mode). */
export function initialFormState(
  template?: SandboxTemplateSummary,
): TemplateFormState {
  return {
    name: template?.name ?? "",
    slug: template?.slug ?? "",
    slugTouched: template != null,
    description: template?.description ?? "",
    provider: template?.provider ?? "modal",
    runtime: template?.runtime ?? "",
    vcpu: numStr(template?.resources.vcpu),
    memoryMb: numStr(template?.resources.memoryMb),
    timeoutMs: numStr(template?.resources.timeoutMs),
    diskMb: numStr(template?.resources.diskMb),
    networkMode: template?.network.mode ?? "public",
    secretKind:
      template && template.secretSelection !== "all" ? "select" : "all",
    selectedKeys:
      template && template.secretSelection !== "all"
        ? template.secretSelection.keyPublicIds
        : [],
    literalRows: template
      ? Object.entries(template.literalEnv).map(([key, value]) => ({
          key,
          value,
        }))
      : [],
    packages: template
      ? template.packages.map((p) => ({
          manager: p.manager,
          names: [...p.names],
        }))
      : [],
    tools: template
      ? template.tools.map((t) => ({
          kind: t.kind,
          ref: t.ref,
          config: t.config,
        }))
      : [],
  };
}

/** The slug actually submitted: typed once the user edits it, else derived from Name. */
export function effectiveSlug(
  state: Pick<TemplateFormState, "name" | "slug" | "slugTouched">,
): string {
  return state.slugTouched ? state.slug : slugify(state.name);
}

export function buildResources(state: TemplateFormState): SandboxResources {
  const r: Record<string, number> = {};
  const push = (k: string, v: string) => {
    const n = Number(v);
    if (v.trim() !== "" && Number.isFinite(n) && n > 0) r[k] = Math.trunc(n);
  };
  push("vcpu", state.vcpu);
  push("memoryMb", state.memoryMb);
  push("timeoutMs", state.timeoutMs);
  push("diskMb", state.diskMb);
  return r as SandboxResources;
}

export function buildLiteralEnv(state: TemplateFormState): SandboxLiteralEnv {
  const env: Record<string, string> = {};
  for (const row of state.literalRows) {
    const k = row.key.trim();
    if (k) env[k] = row.value;
  }
  return env;
}

export function buildSecretSelection(
  state: TemplateFormState,
): SandboxSecretSelection {
  return state.secretKind === "all"
    ? "all"
    : { keyPublicIds: state.selectedKeys };
}

/** Drop any tool row the user started but never gave a `ref` to. */
export function cleanTools(state: TemplateFormState): SandboxTemplateTool[] {
  return state.tools.filter((t) => t.ref.trim() !== "");
}

/**
 * Normalize the package rows for submit: trim each name, drop blank names, and
 * drop any manager row left with no packages (a row the user added but never
 * filled). Order is preserved.
 */
export function cleanPackages(
  state: TemplateFormState,
): SandboxTemplatePackages {
  return state.packages
    .map((group) => ({
      manager: group.manager,
      names: group.names.map((n) => n.trim()).filter((n) => n !== ""),
    }))
    .filter((group) => group.names.length > 0);
}

/**
 * Mirrors `exportTemplate`'s secretKeys resolution
 * (packages/plugins/src/environments/sandbox-template-service.ts) so the live
 * preview shows exactly the NAME-only entries a real export/import would
 * carry: every workspace vault key when secretKind is "all" (required:false),
 * or just the selected ones (required:true) otherwise.
 */
export function buildSecretKeys(
  state: TemplateFormState,
  secretKeys: SecretKeySummary[],
): ManifestSecretKey[] {
  if (state.secretKind === "all") {
    return secretKeys.map((k) => ({
      key: k.key,
      sensitive: k.sensitive,
      memo: k.memo ?? null,
      required: false,
    }));
  }
  const selected = new Set(state.selectedKeys);
  return secretKeys
    .filter((k) => selected.has(k.id))
    .map((k) => ({
      key: k.key,
      sensitive: k.sensitive,
      memo: k.memo ?? null,
      required: true,
    }));
}

/** Build a full manifest v1 input document from the current form state. */
export function buildManifestInput(
  state: TemplateFormState,
  opts: { secretKeys: SecretKeySummary[] },
): SandboxTemplateManifestInput {
  return {
    kind: SANDBOX_TEMPLATE_MANIFEST_KIND,
    version: 1,
    name: state.name.trim(),
    slug: effectiveSlug(state),
    description: state.description.trim() || null,
    provider: state.provider,
    runtime: state.runtime.trim() || null,
    resources: buildResources(state),
    network: { mode: state.networkMode },
    secretSelection: buildSecretSelection(state),
    literalEnv: buildLiteralEnv(state),
    packages: cleanPackages(state),
    tools: cleanTools(state),
    secretKeys: buildSecretKeys(state, opts.secretKeys),
  };
}

export interface ManifestFieldError {
  /** Dot path into the manifest document, or "(root)" for a document-level issue. */
  path: string;
  message: string;
}

/** Render a ZodError as a flat, UI-friendly path+message list — never a raw zod dump. */
export function formatZodErrors(error: z.ZodError): ManifestFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

export type ManifestValidationResult =
  | { ok: true; manifest: SandboxTemplateManifest }
  | { ok: false; errors: ManifestFieldError[] };

/** Validate an arbitrary value (build output, pasted import JSON, …) against manifest v1. */
export function validateManifestInput(
  input: unknown,
): ManifestValidationResult {
  const result = sandboxTemplateManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  return { ok: false, errors: formatZodErrors(result.error) };
}
