"use client";
/**
 * sandbox-templates-panel.tsx — the sandbox-template section of the Sandboxes
 * page: templates grouped by environment, plus the create/edit dialog and the
 * manifest import dialog.
 *
 * Every server action it calls is INJECTED as a prop by `page.tsx` rather than
 * imported here, so this file stays a pure client component and the same panel
 * can be driven by a mock in tests. `canManage` hides every mutating control;
 * the actions re-check the workspace role server-side regardless, because a
 * hidden button is not an authorization gate.
 */

import { useState, useMemo, useTransition } from "react";
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
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
  TabsIndicator,
} from "@/components/ui/tabs";
import type {
  SandboxTemplateManifest,
  SandboxTemplateTool,
} from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import type {
  EnvironmentSummary,
  SecretKeySummary,
} from "../environments/actions";
import type {
  ActionResult,
  SandboxTemplateSummary,
  ToolSourceOption,
} from "./sandbox-template-actions";
import {
  Field,
  NativeSelect,
} from "@/components/sandbox/templates/field-controls";
import { IdentitySection } from "@/components/sandbox/templates/identity-section";
import { ProviderRuntimeSection } from "@/components/sandbox/templates/provider-runtime-section";
import { ResourcesSection } from "@/components/sandbox/templates/resources-section";
import { NetworkSection } from "@/components/sandbox/templates/network-section";
import { PackagesSection } from "@/components/sandbox/templates/packages-section";
import { SecretsEnvSection } from "@/components/sandbox/templates/secrets-env-section";
import { ToolsSection } from "@/components/sandbox/templates/tools-section";
import { DefaultsSection } from "@/components/sandbox/templates/defaults-section";
import { ManifestPreviewPanel } from "@/components/sandbox/templates/manifest-preview-panel";
import { ManifestReferenceSheet } from "@/components/sandbox/templates/manifest-reference-sheet";
import { ManifestErrorList } from "@/components/sandbox/templates/manifest-error-list";
import { TemplateSpecChips } from "@/components/sandbox/templates/template-spec-chips";
import {
  initialFormState,
  effectiveSlug as computeEffectiveSlug,
  buildResources,
  buildLiteralEnv,
  buildSecretSelection,
  cleanTools,
  cleanPackages,
  validateManifestInput,
  type ManifestFieldError,
  type TemplateFormState,
} from "@/components/sandbox/templates/manifest-form-state";

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
      provider?: SandboxTemplateSummary["provider"];
      runtime?: string | null;
      resources?: SandboxTemplateSummary["resources"];
      network?: SandboxTemplateSummary["network"];
      secretSelection?: SandboxTemplateSummary["secretSelection"];
      literalEnv?: SandboxTemplateSummary["literalEnv"];
      packages?: SandboxTemplateSummary["packages"];
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
      provider?: SandboxTemplateSummary["provider"];
      runtime?: string | null;
      resources?: SandboxTemplateSummary["resources"];
      network?: SandboxTemplateSummary["network"];
      secretSelection?: SandboxTemplateSummary["secretSelection"];
      literalEnv?: SandboxTemplateSummary["literalEnv"];
      packages?: SandboxTemplateSummary["packages"];
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
  ) => Promise<
    ActionResult<{ template: SandboxTemplateSummary; warnings: string[] }>
  >;
}

export function SandboxTemplatesPanel(props: Props) {
  const {
    orgSlug,
    workspaceSlug,
    canManage,
    environments,
    secretKeys,
    templates,
    toolSources,
  } = props;
  const scope: Scope = { orgSlug, workspaceSlug };

  // Dialog state: create (env preset), edit (existing template), or import.
  const [createEnvId, setCreateEnvId] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] =
    useState<SandboxTemplateSummary | null>(null);
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
    // Revoke on the next task, not inline: some browsers only begin reading the
    // blob after the click handler returns, and revoking synchronously cancels
    // the download before a single byte is written.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section
      className="flex flex-col gap-4"
      data-testid="sandbox-templates-section"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium">Sandbox templates</h2>
          <p className="text-sm text-muted-foreground">
            Portable, per-environment sandbox blueprints: provider, runtime
            image, resources, network posture, vault keys, literal config, and
            preloaded tools. Export a template as a manifest to share it; import
            one into any environment.
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
                <span className="text-xs text-muted-foreground">
                  {env.slug}
                </span>
                {env.isDefault && (
                  <Badge variant="outline" size="sm">
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
              <p className="text-xs text-muted-foreground">
                No templates in this environment yet.
              </p>
            ) : (
              <ul className="divide-y divide-border/30 overflow-hidden rounded-md border border-border/40 text-sm">
                {list.map((t) => (
                  <li
                    key={t.id}
                    className="flex flex-col gap-3 px-2 py-1.5 sm:flex-row sm:items-center sm:gap-6"
                    data-testid={`sandbox-template-row-${t.slug}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{t.name}</span>
                        {t.isDefault && (
                          <Badge variant="outline" size="sm">
                            ★ default
                          </Badge>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {t.slug}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <TemplateSpecChips template={t} />
                      <Badge
                        variant={t.isActive ? "success-soft" : "muted"}
                        size="sm"
                      >
                        {t.isActive ? "active" : "inactive"}
                      </Badge>
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
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
                                const res =
                                  await props.setDefaultTemplateAction({
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
                    )}
                  </li>
                ))}
              </ul>
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
  const [state, setState] = useState<TemplateFormState>(() =>
    initialFormState(template),
  );
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const patch = (partial: Partial<TemplateFormState>) =>
    setState((s) => ({ ...s, ...partial }));

  const slug = computeEffectiveSlug(state);

  const submit = () =>
    start(async () => {
      setError(null);
      const resources = buildResources(state);
      const literalEnv = buildLiteralEnv(state);
      const secretSelection = buildSecretSelection(state);
      const network = {
        mode: state.networkMode,
      } as SandboxTemplateSummary["network"];
      const packages = cleanPackages(state);
      const tools = cleanTools(state);

      if (mode === "create") {
        const res = await createTemplateAction({
          ...scope,
          environmentId,
          name: state.name.trim(),
          slug,
          description: state.description.trim() || null,
          provider: state.provider,
          runtime: state.runtime.trim() || null,
          resources,
          network,
          secretSelection,
          literalEnv,
          packages,
          tools,
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
        name: state.name.trim(),
        slug,
        description: state.description.trim() || null,
        provider: state.provider,
        runtime: state.runtime.trim() || null,
        resources,
        network,
        secretSelection,
        literalEnv,
        packages,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const toolsRes = await setTemplateToolsAction({
        ...scope,
        templateId: template!.id,
        tools,
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
            {mode === "create"
              ? "New sandbox template"
              : "Edit sandbox template"}
          </DialogTitle>
          <DialogDescription>
            Environment: <strong>{environmentName}</strong>. A portable
            blueprint for provisioning a sandbox — every field is carried in the
            exported manifest.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
          <div className="flex justify-end">
            <ManifestReferenceSheet />
          </div>

          <Tabs defaultValue="configure">
            <TabsList variant="underline" className="relative mb-3">
              <TabsTab value="configure">Configure</TabsTab>
              <TabsTab
                value="manifest"
                data-testid="sandbox-template-manifest-tab"
              >
                Manifest
              </TabsTab>
              <TabsIndicator />
            </TabsList>

            <TabsPanel value="configure" className="flex flex-col gap-3">
              <IdentitySection
                name={state.name}
                onNameChange={(name) => patch({ name })}
                slug={slug}
                onSlugChange={(newSlug) =>
                  patch({ slug: newSlug, slugTouched: true })
                }
                description={state.description}
                onDescriptionChange={(description) => patch({ description })}
              />

              <ProviderRuntimeSection
                provider={state.provider}
                onProviderChange={(provider) => patch({ provider })}
                runtime={state.runtime}
                onRuntimeChange={(runtime) => patch({ runtime })}
              />

              <ResourcesSection
                vcpu={state.vcpu}
                onVcpuChange={(vcpu) => patch({ vcpu })}
                memoryMb={state.memoryMb}
                onMemoryMbChange={(memoryMb) => patch({ memoryMb })}
                timeoutMs={state.timeoutMs}
                onTimeoutMsChange={(timeoutMs) => patch({ timeoutMs })}
                diskMb={state.diskMb}
                onDiskMbChange={(diskMb) => patch({ diskMb })}
              />

              <NetworkSection
                networkMode={state.networkMode}
                onNetworkModeChange={(networkMode) => patch({ networkMode })}
              />

              <PackagesSection
                packages={state.packages}
                onPackagesChange={(packages) => patch({ packages })}
              />

              <SecretsEnvSection
                radioGroupName={`secret-kind-${template?.id ?? "new"}`}
                secretKind={state.secretKind}
                onSecretKindChange={(secretKind) => patch({ secretKind })}
                secretKeys={secretKeys}
                selectedKeys={state.selectedKeys}
                onSelectedKeysChange={(selectedKeys) => patch({ selectedKeys })}
                literalRows={state.literalRows}
                onLiteralRowsChange={(literalRows) => patch({ literalRows })}
              />

              <ToolsSection
                tools={state.tools}
                onToolsChange={(tools) => patch({ tools })}
                toolSources={toolSources}
              />

              {mode === "create" && (
                <DefaultsSection
                  setAsDefault={setAsDefault}
                  onSetAsDefaultChange={setSetAsDefault}
                />
              )}
            </TabsPanel>

            <TabsPanel value="manifest">
              <ManifestPreviewPanel
                state={state}
                secretKeys={secretKeys}
                downloadSlug={slug}
              />
            </TabsPanel>
          </Tabs>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </DialogPanel>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" className="max-md:h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="max-md:h-11"
            disabled={pending || !state.name.trim() || !slug.trim()}
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
  const [parseErrors, setParseErrors] = useState<ManifestFieldError[] | null>(
    null,
  );
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? "");
  const [slugOverride, setSlugOverride] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setText("");
    setParsed(null);
    setParseErrors(null);
    setSlugOverride("");
    setSetAsDefault(false);
    setWarnings(null);
    setError(null);
  };

  const preview = () => {
    setParseErrors(null);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setParseErrors([{ path: "(root)", message: "Not valid JSON." }]);
      setParsed(null);
      return;
    }
    const result = validateManifestInput(json);
    if (!result.ok) {
      setParseErrors(result.errors);
      setParsed(null);
      return;
    }
    setParsed(result.manifest);
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
            Paste an exported manifest. Missing vault keys are created (no
            values) so the Secrets grid shows exactly what to fill in. The
            manifest never carries secret values.
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
          {parseErrors && <ManifestErrorList errors={parseErrors} />}

          {parsed && (
            <div className="rounded-md border border-border/40 p-3 text-sm">
              <div className="font-medium">{parsed.name}</div>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                <dt>slug</dt>
                <dd className="font-mono">
                  {slugOverride.trim() || parsed.slug}
                </dd>
                <dt>provider</dt>
                <dd>{parsed.provider}</dd>
                <dt>network</dt>
                <dd>{parsed.network.mode}</dd>
                <dt>packages</dt>
                <dd>
                  {parsed.packages.reduce((n, g) => n + g.names.length, 0)}
                </dd>
                <dt>tools</dt>
                <dd>{parsed.tools.length}</dd>
                <dt>secret keys</dt>
                <dd>{parsed.secretKeys.map((k) => k.key).join(", ") || "—"}</dd>
              </dl>

              <div className="mt-3 flex flex-col gap-2">
                <Field label="Target environment">
                  <NativeSelect
                    value={environmentId}
                    onChange={setEnvironmentId}
                  >
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
                  <Switch
                    checked={setAsDefault}
                    onCheckedChange={setSetAsDefault}
                  />
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
            <Button
              className="max-md:h-11"
              disabled={pending || !text.trim()}
              onClick={preview}
            >
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
