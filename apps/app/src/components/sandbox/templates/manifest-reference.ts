/**
 * manifest-reference.ts — the single structured data module answering "what
 * are ALL the configs I can make in the sandbox manifest file". Rendered by
 * `manifest-reference-sheet.tsx`; its top-level `key`s are asserted (in
 * manifest-reference.test.ts) to exactly match
 * `sandboxTemplateManifestSchema.shape`'s keys, so a schema addition that
 * isn't documented here fails a test instead of silently going undiscoverable.
 *
 * This is the one place to update when the manifest schema grows — every
 * other reference to "what does this field mean" (the section forms, the
 * reference Sheet) reads from here or from manifest-field-meta.ts.
 */
import { SANDBOX_TEMPLATE_MANIFEST_KIND } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import {
  PROVIDER_OPTIONS,
  NETWORK_MODE_META,
  NETWORK_MODE_OPTIONS,
  RESOURCE_FIELD_META,
  RESOURCE_LIMITS,
  TOOL_KIND_OPTIONS,
} from "./manifest-field-meta";

export interface ManifestFieldRef {
  /** Dot path into the manifest document (array fields use `[]`). */
  path: string;
  type: string;
  /** Allowed values / numeric range, as a short human string. */
  values: string;
  description: string;
  providerNotes?: string;
}

export interface ManifestSectionRef {
  /** Must match a key of `sandboxTemplateManifestSchema.shape` — see the test. */
  key: string;
  label: string;
  summary: string;
  fields: ManifestFieldRef[];
}

const NETWORK_MODE_VALUES = NETWORK_MODE_OPTIONS.map((mode) => {
  const meta = NETWORK_MODE_META[mode];
  return meta.provisionable ? mode : `${mode} (not yet provisionable)`;
}).join(" | ");

const NOT_PROVISIONABLE_MODES = NETWORK_MODE_OPTIONS.filter(
  (mode) => !NETWORK_MODE_META[mode].provisionable,
);

export const MANIFEST_REFERENCE: ManifestSectionRef[] = [
  {
    key: "kind",
    label: "Kind",
    summary: "Document type discriminator.",
    fields: [
      {
        path: "kind",
        type: "literal",
        values: `"${SANDBOX_TEMPLATE_MANIFEST_KIND}"`,
        description:
          "Identifies this JSON document as a sandbox-template manifest. Always this exact value; the editor sets it for you.",
      },
    ],
  },
  {
    key: "version",
    label: "Version",
    summary: "Manifest schema version.",
    fields: [
      {
        path: "version",
        type: "literal",
        values: "1",
        description:
          "Bumped only on a breaking manifest-schema change; an importer that doesn't recognize the version rejects the document.",
      },
    ],
  },
  {
    key: "name",
    label: "Name",
    summary: "Human-readable template name.",
    fields: [
      {
        path: "name",
        type: "string",
        values: "non-empty",
        description:
          "Shown in the sandbox templates panel and template pickers.",
      },
    ],
  },
  {
    key: "slug",
    label: "Slug",
    summary: "Stable identifier for the template.",
    fields: [
      {
        path: "slug",
        type: "string",
        values: "non-empty, unique within an environment",
        description:
          "URL/DB-safe identifier. Auto-derived from Name until you edit it directly; on import, a slug collision is a hard error unless you supply an override.",
      },
    ],
  },
  {
    key: "description",
    label: "Description",
    summary: "Optional free-text notes.",
    fields: [
      {
        path: "description",
        type: "string | null",
        values: "optional",
        description:
          "What this sandbox is for — purely descriptive, never parsed.",
      },
    ],
  },
  {
    key: "provider",
    label: "Provider",
    summary: "Which sandbox compute vendor provisions this template.",
    fields: [
      {
        path: "provider",
        type: "enum",
        values: PROVIDER_OPTIONS.join(" | "),
        description: "Selects the driver that boots the sandbox for a run.",
        providerNotes:
          "modal, vercel, and docker are declared identically by the manifest — switching providers later is a one-field change, as long as the runtime image and vault key NAMES exist on the new provider too.",
      },
    ],
  },
  {
    key: "runtime",
    label: "Runtime image",
    summary: "The base image/container the provider boots.",
    fields: [
      {
        path: "runtime",
        type: "string | null",
        values: "optional (e.g. an OCI image ref)",
        description:
          "Blank uses the provider's default base image. When set, it must be pullable by whichever provider ultimately runs this template.",
      },
    ],
  },
  {
    key: "resources",
    label: "Resources",
    summary:
      "Bounded compute envelope — every field optional; unset falls back to the provider's default.",
    fields: (
      Object.keys(RESOURCE_LIMITS) as (keyof typeof RESOURCE_LIMITS)[]
    ).map((field) => ({
      path: `resources.${field}`,
      type: "number (optional)",
      values: `1–${RESOURCE_LIMITS[field]}`,
      description: RESOURCE_FIELD_META[field].help,
    })),
  },
  {
    key: "network",
    label: "Network",
    summary: "Network posture the sandbox provisions with.",
    fields: [
      {
        path: "network.mode",
        type: "enum",
        values: NETWORK_MODE_VALUES,
        description:
          "The egress/connectivity posture requested for the sandbox.",
        providerNotes:
          NOT_PROVISIONABLE_MODES.length > 0
            ? `${NOT_PROVISIONABLE_MODES.map((m) => NETWORK_MODE_META[m].label).join(", ")} are declared for portability; not yet provisionable — a run requesting one fails fast at provision time.`
            : undefined,
      },
      {
        path: "network.config",
        type: "record<string, unknown> (optional)",
        values: "mode-specific",
        description:
          "Provisioning detail specific to the chosen mode (e.g. a bastion host address).",
      },
    ],
  },
  {
    key: "secretSelection",
    label: "Secret selection",
    summary: "Which vault keys resolve into the sandbox at run time.",
    fields: [
      {
        path: "secretSelection",
        type: '"all" | { keyPublicIds: string[] }',
        values: '"all" or an explicit allow-list',
        description:
          '"all" resolves every live workspace vault key; an allow-list resolves only the listed keys. This is workspace-specific — it travels by internal id, not by name.',
      },
    ],
  },
  {
    key: "literalEnv",
    label: "Literal env",
    summary: "Plain, non-secret KEY=value pairs.",
    fields: [
      {
        path: "literalEnv",
        type: "record<string, string>",
        values: "any KEY=value pairs",
        description:
          "Injected at the lowest precedence (secrets win on conflict). NEVER put secret material here — use secretSelection + secretKeys instead.",
      },
    ],
  },
  {
    key: "tools",
    label: "Preloaded tools",
    summary: "Tool bindings preloaded into the sandbox.",
    fields: [
      {
        path: "tools[].kind",
        type: "enum",
        values: TOOL_KIND_OPTIONS.join(" | "),
        description: "What kind of tool this binding refers to.",
      },
      {
        path: "tools[].ref",
        type: "string",
        values: "non-empty",
        description:
          "The capability name / MCP server id / skill slug / tool ref, depending on kind.",
      },
      {
        path: "tools[].config",
        type: "record<string, unknown> (optional)",
        values: "kind-specific",
        description: "Extra configuration for this specific tool binding.",
      },
    ],
  },
  {
    key: "packages",
    label: "Packages",
    summary:
      "Per-ecosystem package lists baked into the sandbox image at provision time.",
    fields: [
      {
        path: "packages[].manager",
        type: "enum",
        values:
          "apt | cargo | gem | go | npm | pnpm | yarn | pip | poetry | uv",
        description:
          "The package manager used to install this group's packages into the image.",
      },
      {
        path: "packages[].names",
        type: "string[]",
        values: "each non-empty; may carry an ecosystem version pin",
        description:
          "Packages to install through the manager, e.g. `fastapi`, `pydantic==2.5`, `left-pad@1.3.0`. An empty list is dropped by the UI before submit.",
      },
    ],
  },
  {
    key: "secretKeys",
    label: "Secret keys",
    summary: "The vault key NAMES (never values) this template expects.",
    fields: [
      {
        path: "secretKeys[].key",
        type: "string",
        values: "^[A-Za-z_][A-Za-z0-9_]*$",
        description:
          "An env-var name — matches the vault's own naming pattern.",
      },
      {
        path: "secretKeys[].sensitive",
        type: "boolean",
        values: "default true",
        description:
          "Whether this key's value should be masked in UIs that display it.",
      },
      {
        path: "secretKeys[].memo",
        type: "string | null (optional)",
        values: "optional",
        description:
          "A short note about what the key is for, shown next to the vault row it creates on import.",
      },
      {
        path: "secretKeys[].required",
        type: "boolean",
        values: "default false",
        description:
          "This is what makes the manifest portable: importing into a new environment creates empty vault rows (name only) for every key here, so the Secrets grid shows exactly what to fill in.",
      },
    ],
  },
];

/** Top-level manifest schema keys this reference documents — see the completeness test. */
export const MANIFEST_REFERENCE_KEYS = MANIFEST_REFERENCE.map(
  (section) => section.key,
);
