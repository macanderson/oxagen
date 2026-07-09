"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  sandboxTemplateManifestSchema,
  type SandboxNetworkMode,
  type SandboxTemplateManifest,
  type SandboxTemplateTool,
} from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import type { EnvironmentSummary, SecretKeySummary } from "./actions";
import type {
  ActionResult,
  SandboxTemplateSummary,
  ToolSourceOption,
} from "./sandbox-actions";

// ── Network-mode metadata (four modes are declared but not yet provisionable) ─

const NETWORK_MODES: {
  value: SandboxNetworkMode;
  label: string;
  comingSoon: boolean;
}[] = [
  { value: "public", label: "Public egress", comingSoon: false },
  { value: "static_egress", label: "Static egress IP", comingSoon: false },
  { value: "aws_privatelink", label: "AWS PrivateLink", comingSoon: true },
  { value: "gcp_psc", label: "GCP Private Service Connect", comingSoon: true },
  { value: "reverse_tunnel", label: "Reverse tunnel", comingSoon: true },
  { value: "ssh_bastion", label: "SSH bastion", comingSoon: true },
];

const PROVIDERS = ["modal", "vercel", "docker"] as const;

interface Scope {
  orgSlug: string;
  workspaceSlug: string;
}

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
  environments: EnvironmentSummary[];
  secretKeys: SecretKeySummary[];
  templates: SandboxTemplateSummary[];
  toolSources: ToolSourceOption[];
  createTemplateAction: (
    args: Scope & {
      environmentId: string;
      name: string;
      slug: string;
      description?: string | null;
      provider?: (typeof PROVIDERS)[number];
      runtime?: string | null;
      resources?: SandboxTemplateSummary["resources"];
      network?: SandboxTemplateSummary["network"];
      secretSelection?: SandboxTemplateSummary["secretSelection"];
      literalEnv?: SandboxTemplateSummary["literalEnv"];
      tools?: SandboxTemplateTool[];
      setAsDefault?: boolean;
    },
  ) => Promise<ActionResult<{ template: SandboxTemplateSummary }>>;
  updateTemplateAction: (
    args: Scope & {
      templateId: string;
      name?: string;
      slug?: string;
      description?: string | null;
      provider?: (typeof PROVIDERS)[number];
      runtime?: string | null;
      resources?: SandboxTemplateSummary["resources"];
      network?: SandboxTemplateSummary["network"];
      secretSelection?: SandboxTemplateSummary["secretSelection"];
      literalEnv?: SandboxTemplateSummary["literalEnv"];
      isActive?: boolean;
    },
  ) => Promise<ActionResult<{ template: SandboxTemplateSummary }>>;
  setTemplateToolsAction: (
    args: Scope & { templateId: string; tools: SandboxTemplateTool[] },
  ) => Promise<ActionResult<{ template: SandboxTemplateSummary }>>;
  setDefaultTemplateAction: (
    args: Scope & { templateId: string },
  ) => Promise<ActionResult<{ template: SandboxTemplateSummary }>>;
  deleteTemplateAction: (
    args: Scope & { templateId: string },
  ) => Promise<ActionResult>;
  exportTemplateAction: (
    args: Scope & { templateId: string },
  ) => Promise<ActionResult<{ manifest: SandboxTemplateManifest }>>;
  importTemplateAction: (
    args: Scope & {
      environmentId: string;
      manifest: SandboxTemplateManifest;
      slug?: string;
      setAsDefault?: boolean;
    },
  ) => Promise<ActionResult<{ template: SandboxTemplateSummary; warnings: string[] }>>;
}

export function SandboxTemplatesPanel(props: Props) {
  const { orgSlug, workspaceSlug, canManage, environments, secretKeys, templates, toolSources } =
    props;
  const scope: Scope = { orgSlug, workspaceSlug };

  // Dialog state: create (env preset), edit (existing template), or import.
  const [createEnvId, setCreateEnvId] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] = useState<SandboxTemplateSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const envName = useMemo(() => {
    const m = new Map(environments.map((e) => [e.id, e]));
    return (id: string) => m.get(id)?.name ?? id;
  }, [environments]);

  const byEnv = useMemo(() => {
    const groups = new Map<string, SandboxTemplateSummary[]>();
    for (const t of templates) {
      const list = groups.get(t.environmentId) ?? [];
      list.push(t);
      groups.set(t.environmentId, list);
    }
    return groups;
  }, [templates]);

  const download = (manifest: SandboxTemplateManifest, slug: string) => {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sandbox-template-${slug}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="flex flex-col gap-4" data-testid="sandbox-templates-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium">Sandbox templates</h2>
          <p className="text-sm text-muted-foreground">
            Portable, per-environment sandbox blueprints: provider, runtime image, resources,
            network posture, vault keys, literal config, and preloaded tools. Export a template as
            a manifest to share it; import one into any environment.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="max-md:h-11"
              disabled={pending || environments.length === 0}
              onClick={() => setImportOpen(true)}
              data-testid="sandbox-template-import-btn"
            >
              Import manifest
            </Button>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="error">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {environments.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Create an environment above before adding sandbox templates.
        </p>
      )}

      {environments.map((env) => {
        const list = byEnv.get(env.id) ?? [];
        return (
          <div
            key={env.id}
            className="flex flex-col gap-2 rounded-md border border-border/40 p-3"
            data-testid={`sandbox-env-group-${env.slug}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{env.name}</span>
                <span className="text-xs text-muted-foreground">{env.slug}</span>
                {env.isDefault && (
                  <Badge variant="secondary" size="sm">
                    ★ default env
                  </Badge>
                )}
              </div>
              {canManage && (
                <Button
                  variant="outline"
                  size="xs"
                  className="max-md:h-11"
                  disabled={pending}
                  onClick={() => setCreateEnvId(env.id)}
                  data-testid={`sandbox-template-new-btn-${env.slug}`}
                >
                  + New template
                </Button>
              )}
            </div>

            {list.length === 0 ? (
              <p className="text-xs text-muted-foreground">No templates in this environment yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/40 text-xs text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium">Name</th>
                      <th className="px-2 py-1.5 text-left font-medium">Provider</th>
                      <th className="px-2 py-1.5 text-left font-medium">Network</th>
                      <th className="px-2 py-1.5 text-left font-medium">Tools</th>
                      <th className="px-2 py-1.5 text-left font-medium">Status</th>
                      {canManage && <th className="px-2 py-1.5" />}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b border-border/30 last:border-0"
                        data-testid={`sandbox-template-row-${t.slug}`}
                      >
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{t.name}</span>
                            {t.isDefault && (
                              <Badge variant="secondary" size="sm">
                                ★ default
                              </Badge>
                            )}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">{t.slug}</div>
                        </td>
                        <td className="px-2 py-1.5">{t.provider}</td>
                        <td className="px-2 py-1.5 text-xs">{t.network.mode}</td>
                        <td className="px-2 py-1.5 text-xs text-muted-foreground">
                          {t.tools.length}
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {t.isActive ? (
                            <span className="text-success">active</span>
                          ) : (
                            <span className="text-muted-foreground">inactive</span>
                          )}
                        </td>
                        {canManage && (
                          <td className="px-2 py-1.5">
                            <div className="flex flex-wrap items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="xs"
                                className="max-md:h-11"
                                disabled={pending}
                                onClick={() => setEditTemplate(t)}
                                data-testid={`sandbox-template-edit-${t.slug}`}
                              >
                                Edit
                              </Button>
                              {!t.isDefault && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="max-md:h-11"
                                  disabled={pending}
                                  onClick={() =>
                                    start(async () => {
                                      setError(null);
                                      const res = await props.setDefaultTemplateAction({
                                        ...scope,
                                        templateId: t.id,
                                      });
                                      if (!res.ok) setError(res.error);
                                    })
                                  }
                                  data-testid={`sandbox-template-setdefault-${t.slug}`}
                                >
                                  Set default
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="xs"
                                className="max-md:h-11"
                                disabled={pending}
                                onClick={() =>
                                  start(async () => {
                                    setError(null);
                                    const res = await props.exportTemplateAction({
                                      ...scope,
                                      templateId: t.id,
                                    });
                                    if (res.ok) download(res.manifest, t.slug);
                                    else setError(res.error);
                                  })
                                }
                                data-testid={`sandbox-template-export-${t.slug}`}
                              >
                                Export
                              </Button>
                              {/* Promote-first guard: a default template cannot be
                                  deleted — promote another first. Mirror the
                                  environments drawer's disabled+tooltip pattern. */}
                              <Button
                                variant="ghost"
                                size="xs"
                                className="max-md:h-11 text-destructive"
                                disabled={pending || t.isDefault}
                                title={
                                  t.isDefault
                                    ? "Promote another template to default before deleting this one."
                                    : undefined
                                }
                                onClick={() =>
                                  start(async () => {
                                    setError(null);
                                    const res = await props.deleteTemplateAction({
                                      ...scope,
                                      templateId: t.id,
                                    });
                                    if (!res.ok) setError(res.error);
                                  })
                                }
                                data-testid={`sandbox-template-delete-${t.slug}`}
                              >
                                Delete
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* Create dialog */}
      {createEnvId && (
        <TemplateDialog
          key={`create-${createEnvId}`}
          mode="create"
          scope={scope}
          environmentId={createEnvId}
          environmentName={envName(createEnvId)}
          secretKeys={secretKeys}
          toolSources={toolSources}
          open
          onClose={() => setCreateEnvId(null)}
          createTemplateAction={props.createTemplateAction}
          updateTemplateAction={props.updateTemplateAction}
          setTemplateToolsAction={props.setTemplateToolsAction}
        />
      )}

      {/* Edit dialog */}
      {editTemplate && (
        <TemplateDialog
          key={`edit-${editTemplate.id}`}
          mode="edit"
          scope={scope}
          environmentId={editTemplate.environmentId}
          environmentName={envName(editTemplate.environmentId)}
          template={editTemplate}
          secretKeys={secretKeys}
          toolSources={toolSources}
          open
          onClose={() => setEditTemplate(null)}
          createTemplateAction={props.createTemplateAction}
          updateTemplateAction={props.updateTemplateAction}
          setTemplateToolsAction={props.setTemplateToolsAction}
        />
      )}

      {/* Import dialog */}
      {canManage && (
        <ImportDialog
          scope={scope}
          environments={environments}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          importTemplateAction={props.importTemplateAction}
        />
      )}
    </section>
  );
}

// ── Create / edit dialog ──────────────────────────────────────────────────────

type SecretSelectionKind = "all" | "select";

function TemplateDialog({
  mode,
  scope,
  environmentId,
  environmentName,
  template,
  secretKeys,
  toolSources,
  open,
  onClose,
  createTemplateAction,
  updateTemplateAction,
  setTemplateToolsAction,
}: {
  mode: "create" | "edit";
  scope: Scope;
  environmentId: string;
  environmentName: string;
  template?: SandboxTemplateSummary;
  secretKeys: SecretKeySummary[];
  toolSources: ToolSourceOption[];
  open: boolean;
  onClose: () => void;
  createTemplateAction: Props["createTemplateAction"];
  updateTemplateAction: Props["updateTemplateAction"];
  setTemplateToolsAction: Props["setTemplateToolsAction"];
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [slug, setSlug] = useState(template?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [description, setDescription] = useState(template?.description ?? "");
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>(
    template?.provider ?? "modal",
  );
  const [runtime, setRuntime] = useState(template?.runtime ?? "");
  const [vcpu, setVcpu] = useState(numStr(template?.resources.vcpu));
  const [memoryMb, setMemoryMb] = useState(numStr(template?.resources.memoryMb));
  const [timeoutMs, setTimeoutMs] = useState(numStr(template?.resources.timeoutMs));
  const [diskMb, setDiskMb] = useState(numStr(template?.resources.diskMb));
  const [networkMode, setNetworkMode] = useState<SandboxNetworkMode>(
    template?.network.mode ?? "public",
  );
  const [secretKind, setSecretKind] = useState<SecretSelectionKind>(
    template && template.secretSelection !== "all" ? "select" : "all",
  );
  const [selectedKeys, setSelectedKeys] = useState<string[]>(
    template && template.secretSelection !== "all"
      ? template.secretSelection.keyPublicIds
      : [],
  );
  const [literalRows, setLiteralRows] = useState<{ key: string; value: string }[]>(
    template ? Object.entries(template.literalEnv).map(([key, value]) => ({ key, value })) : [],
  );
  const [tools, setTools] = useState<SandboxTemplateTool[]>(
    template ? template.tools.map((t) => ({ kind: t.kind, ref: t.ref, config: t.config })) : [],
  );
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const effectiveSlug = slugTouched ? slug : slugify(name);

  const buildResources = () => {
    const r: Record<string, number> = {};
    const push = (k: string, v: string) => {
      const n = Number(v);
      if (v.trim() !== "" && Number.isFinite(n) && n > 0) r[k] = Math.trunc(n);
    };
    push("vcpu", vcpu);
    push("memoryMb", memoryMb);
    push("timeoutMs", timeoutMs);
    push("diskMb", diskMb);
    return r as SandboxTemplateSummary["resources"];
  };

  const buildLiteralEnv = () => {
    const env: Record<string, string> = {};
    for (const row of literalRows) {
      const k = row.key.trim();
      if (k) env[k] = row.value;
    }
    return env;
  };

  const buildSecretSelection = (): SandboxTemplateSummary["secretSelection"] =>
    secretKind === "all" ? "all" : { keyPublicIds: selectedKeys };

  const submit = () =>
    start(async () => {
      setError(null);
      const resources = buildResources();
      const literalEnv = buildLiteralEnv();
      const secretSelection = buildSecretSelection();
      const network = { mode: networkMode } as SandboxTemplateSummary["network"];
      const cleanTools = tools.filter((t) => t.ref.trim() !== "");

      if (mode === "create") {
        const res = await createTemplateAction({
          ...scope,
          environmentId,
          name: name.trim(),
          slug: effectiveSlug,
          description: description.trim() || null,
          provider,
          runtime: runtime.trim() || null,
          resources,
          network,
          secretSelection,
          literalEnv,
          tools: cleanTools,
          setAsDefault,
        });
        if (res.ok) onClose();
        else setError(res.error);
        return;
      }

      // Edit: update the config, then replace-set the tools (separate contract).
      const res = await updateTemplateAction({
        ...scope,
        templateId: template!.id,
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        provider,
        runtime: runtime.trim() || null,
        resources,
        network,
        secretSelection,
        literalEnv,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const toolsRes = await setTemplateToolsAction({
        ...scope,
        templateId: template!.id,
        tools: cleanTools,
      });
      if (!toolsRes.ok) {
        setError(toolsRes.error);
        return;
      }
      onClose();
    });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New sandbox template" : "Edit sandbox template"}
          </DialogTitle>
          <DialogDescription>
            Environment: <strong>{environmentName}</strong>. A portable blueprint for provisioning a
            sandbox — every field is carried in the exported manifest.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                className="max-md:h-11"
                value={name}
                placeholder="SWE-bench runner"
                onChange={(e) => setName(e.target.value)}
                data-testid="sandbox-template-name-input"
              />
            </Field>
            <Field label="Slug">
              <Input
                className="max-md:h-11 font-mono"
                value={effectiveSlug}
                placeholder="swe-bench-runner"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </Field>
          </div>

          <Field label="Description">
            <Textarea
              value={description}
              rows={2}
              placeholder="What this sandbox is for."
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <NativeSelect
                value={provider}
                onChange={(v) => setProvider(v as (typeof PROVIDERS)[number])}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Runtime image ref">
              <Input
                className="max-md:h-11 font-mono"
                value={runtime}
                placeholder="ghcr.io/oxageninc/oxagen-ci-base:latest"
                onChange={(e) => setRuntime(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Resources (blank = provider default)">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <BoundedNumber label="vCPU" max={4} value={vcpu} onChange={setVcpu} />
              <BoundedNumber label="Memory MB" max={8192} value={memoryMb} onChange={setMemoryMb} />
              <BoundedNumber
                label="Timeout ms"
                max={300000}
                value={timeoutMs}
                onChange={setTimeoutMs}
              />
              <BoundedNumber label="Disk MB" max={20480} value={diskMb} onChange={setDiskMb} />
            </div>
          </Field>

          <Field label="Network mode">
            <NativeSelect
              value={networkMode}
              onChange={(v) => setNetworkMode(v as SandboxNetworkMode)}
            >
              {NETWORK_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                  {m.comingSoon ? " — coming soon (fails at provision)" : ""}
                </option>
              ))}
            </NativeSelect>
            {NETWORK_MODES.find((m) => m.value === networkMode)?.comingSoon && (
              <p className="text-xs text-warning">
                This network mode is not yet provisionable — a run using it will fail fast at
                provision time.
              </p>
            )}
          </Field>

          <Field label="Secret selection">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`secret-kind-${template?.id ?? "new"}`}
                  checked={secretKind === "all"}
                  onChange={() => setSecretKind("all")}
                />
                All workspace vault keys
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`secret-kind-${template?.id ?? "new"}`}
                  checked={secretKind === "select"}
                  onChange={() => setSecretKind("select")}
                />
                Only selected keys
              </label>
              {secretKind === "select" && (
                <div className="flex flex-col gap-1 rounded-md border border-border/40 p-2">
                  {secretKeys.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      No vault keys yet — add keys in the Secrets section above.
                    </span>
                  )}
                  {secretKeys.map((k) => (
                    <label key={k.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(k.id)}
                        onChange={(e) =>
                          setSelectedKeys((prev) =>
                            e.target.checked
                              ? [...prev, k.id]
                              : prev.filter((id) => id !== k.id),
                          )
                        }
                      />
                      <span className="font-mono">{k.key}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </Field>

          <LiteralEnvEditor rows={literalRows} setRows={setLiteralRows} />

          <ToolsEditor tools={tools} setTools={setTools} toolSources={toolSources} />

          {mode === "create" && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={setAsDefault} onCheckedChange={setSetAsDefault} />
              Set as this environment&apos;s default template
            </label>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </DialogPanel>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" className="max-md:h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="max-md:h-11"
            disabled={pending || !name.trim() || !effectiveSlug.trim()}
            onClick={submit}
            data-testid="sandbox-template-save-btn"
          >
            {mode === "create" ? "Create template" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── Literal env editor ────────────────────────────────────────────────────────

function LiteralEnvEditor({
  rows,
  setRows,
}: {
  rows: { key: string; value: string }[];
  setRows: (rows: { key: string; value: string }[]) => void;
}) {
  return (
    <Field label="Literal env (non-sensitive config — never secrets)">
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              className="max-md:h-11 font-mono"
              value={row.key}
              placeholder="LOG_LEVEL"
              onChange={(e) =>
                setRows(rows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))
              }
            />
            <span className="text-muted-foreground">=</span>
            <Input
              className="max-md:h-11 font-mono"
              value={row.value}
              placeholder="info"
              onChange={(e) =>
                setRows(rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))
              }
            />
            <Button
              variant="ghost"
              size="xs"
              className="max-md:h-11"
              onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="xs"
          className="max-md:h-11 self-start"
          onClick={() => setRows([...rows, { key: "", value: "" }])}
        >
          + Add config row
        </Button>
      </div>
    </Field>
  );
}

// ── Tools editor ──────────────────────────────────────────────────────────────

const TOOL_KINDS: SandboxTemplateTool["kind"][] = [
  "capability",
  "mcp_server",
  "agent_skill",
  "tool",
];

function ToolsEditor({
  tools,
  setTools,
  toolSources,
}: {
  tools: SandboxTemplateTool[];
  setTools: (tools: SandboxTemplateTool[]) => void;
  toolSources: ToolSourceOption[];
}) {
  const listId = "sandbox-tool-suggestions";
  return (
    <Field label="Preloaded tools (workspace-installed)">
      <div className="flex flex-col gap-2">
        <datalist id={listId}>
          {toolSources.map((s) => (
            <option key={`${s.kind}:${s.ref}`} value={s.ref}>
              {s.label} ({s.kind})
            </option>
          ))}
        </datalist>
        {tools.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <NativeSelect
              value={t.kind}
              onChange={(v) =>
                setTools(
                  tools.map((tool, idx) =>
                    idx === i ? { ...tool, kind: v as SandboxTemplateTool["kind"] } : tool,
                  ),
                )
              }
            >
              {TOOL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </NativeSelect>
            <Input
              className="max-md:h-11 font-mono"
              list={listId}
              value={t.ref}
              placeholder="ref (capability name / skill or server id)"
              onChange={(e) =>
                setTools(tools.map((tool, idx) => (idx === i ? { ...tool, ref: e.target.value } : tool)))
              }
            />
            <Button
              variant="ghost"
              size="xs"
              className="max-md:h-11"
              onClick={() => setTools(tools.filter((_, idx) => idx !== i))}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="xs"
          className="max-md:h-11 self-start"
          onClick={() => setTools([...tools, { kind: "capability", ref: "" }])}
          data-testid="sandbox-template-add-tool"
        >
          + Add tool
        </Button>
      </div>
    </Field>
  );
}

// ── Import dialog ─────────────────────────────────────────────────────────────

function ImportDialog({
  scope,
  environments,
  open,
  onClose,
  importTemplateAction,
}: {
  scope: Scope;
  environments: EnvironmentSummary[];
  open: boolean;
  onClose: () => void;
  importTemplateAction: Props["importTemplateAction"];
}) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<SandboxTemplateManifest | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? "");
  const [slugOverride, setSlugOverride] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setText("");
    setParsed(null);
    setParseError(null);
    setSlugOverride("");
    setSetAsDefault(false);
    setWarnings(null);
    setError(null);
  };

  const preview = () => {
    setParseError(null);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setParseError("Not valid JSON.");
      setParsed(null);
      return;
    }
    const result = sandboxTemplateManifestSchema.safeParse(json);
    if (!result.success) {
      setParseError(result.error.issues[0]?.message ?? "Not a valid sandbox-template manifest.");
      setParsed(null);
      return;
    }
    setParsed(result.data);
  };

  const confirm = () =>
    start(async () => {
      if (!parsed) return;
      setError(null);
      const res = await importTemplateAction({
        ...scope,
        environmentId,
        manifest: parsed,
        slug: slugOverride.trim() || undefined,
        setAsDefault,
      });
      if (res.ok) {
        setWarnings(res.warnings);
        if (res.warnings.length === 0) {
          reset();
          onClose();
        }
      } else {
        setError(res.error);
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import sandbox template</DialogTitle>
          <DialogDescription>
            Paste an exported manifest. Missing vault keys are created (no values) so the Secrets
            grid shows exactly what to fill in. The manifest never carries secret values.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParsed(null);
              setWarnings(null);
            }}
            rows={8}
            placeholder='{ "kind": "oxagen.sandbox-template", "version": 1, ... }'
            className="font-mono text-xs"
            data-testid="sandbox-import-textarea"
          />
          {parseError && <p className="text-xs text-destructive">{parseError}</p>}

          {parsed && (
            <div className="rounded-md border border-border/40 p-3 text-sm">
              <div className="font-medium">{parsed.name}</div>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                <dt>slug</dt>
                <dd className="font-mono">{slugOverride.trim() || parsed.slug}</dd>
                <dt>provider</dt>
                <dd>{parsed.provider}</dd>
                <dt>network</dt>
                <dd>{parsed.network.mode}</dd>
                <dt>tools</dt>
                <dd>{parsed.tools.length}</dd>
                <dt>secret keys</dt>
                <dd>{parsed.secretKeys.map((k) => k.key).join(", ") || "—"}</dd>
              </dl>

              <div className="mt-3 flex flex-col gap-2">
                <Field label="Target environment">
                  <NativeSelect value={environmentId} onChange={setEnvironmentId}>
                    {environments.map((env) => (
                      <option key={env.id} value={env.id}>
                        {env.name} ({env.slug})
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Slug override (optional — to resolve a collision)">
                  <Input
                    className="max-md:h-11 font-mono"
                    value={slugOverride}
                    placeholder={parsed.slug}
                    onChange={(e) => setSlugOverride(e.target.value)}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={setAsDefault} onCheckedChange={setSetAsDefault} />
                  Set as the target environment&apos;s default
                </label>
              </div>
            </div>
          )}

          {warnings && warnings.length > 0 && (
            <Alert variant="warning">
              <AlertTitle>Imported with warnings</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </DialogPanel>
        <DialogFooter className="flex-wrap">
          <Button
            variant="outline"
            className="max-md:h-11"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            {warnings ? "Close" : "Cancel"}
          </Button>
          {!parsed ? (
            <Button className="max-md:h-11" disabled={pending || !text.trim()} onClick={preview}>
              Preview
            </Button>
          ) : (
            <Button
              className="max-md:h-11"
              disabled={pending || !environmentId}
              onClick={confirm}
              data-testid="sandbox-import-confirm-btn"
            >
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function NativeSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      className="max-md:h-11 rounded-md border border-border/50 bg-background px-2 py-1.5 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

function BoundedNumber({
  label,
  max,
  value,
  onChange,
}: {
  label: string;
  max: number;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={1}
        max={max}
        className="max-md:h-11"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function numStr(n: number | undefined): string {
  return n === undefined || n === null ? "" : String(n);
}

function slugify(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
