"use client";

import { useState, useTransition } from "react";
import { slugify } from "@/lib/slug";
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
import type {
  ActionResult,
  EnvironmentSummary,
  SecretKeySummary,
  ImportPreviewRow,
} from "./actions";

type ImportEnvAction = (args: {
  orgSlug: string;
  workspaceSlug: string;
  text: string;
  environmentId?: string | null;
  commit: boolean;
}) => Promise<ActionResult<{ rows: ImportPreviewRow[]; committed: boolean }>>;

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
  environments: EnvironmentSummary[];
  secretKeys: SecretKeySummary[];
  /**
   * True when the server-side environments/secrets read failed and the grid was
   * degraded to empty. Drives an inline notice so a read failure doesn't look
   * like the workspace's secrets were deleted.
   */
  loadError?: boolean;
  importEnvAction: ImportEnvAction;
  upsertKeyAction: (args: {
    orgSlug: string;
    workspaceSlug: string;
    key: string;
    sensitive: boolean;
    memo?: string | null;
    defaultValue?: string | null;
  }) => Promise<ActionResult<{ id: string }>>;
  setValueAction: (args: {
    orgSlug: string;
    workspaceSlug: string;
    keyId: string;
    environmentId: string;
    value: string;
  }) => Promise<ActionResult>;
  unsetValueAction: (args: {
    orgSlug: string;
    workspaceSlug: string;
    keyId: string;
    environmentId: string;
  }) => Promise<ActionResult>;
  deleteKeyAction: (args: {
    orgSlug: string;
    workspaceSlug: string;
    keyId: string;
  }) => Promise<ActionResult>;
  createEnvironmentAction: (args: {
    orgSlug: string;
    workspaceSlug: string;
    name: string;
    slug: string;
  }) => Promise<ActionResult<{ environment: EnvironmentSummary }>>;
  setDefaultEnvironmentAction: (args: {
    orgSlug: string;
    workspaceSlug: string;
    environmentId: string;
  }) => Promise<ActionResult<{ environment: EnvironmentSummary }>>;
}

export function EnvironmentsPanel(props: Props) {
  const {
    orgSlug,
    workspaceSlug,
    canManage,
    environments,
    secretKeys,
    loadError,
  } = props;
  const scope = { orgSlug, workspaceSlug };
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-6">
      {loadError && (
        <Alert variant="error">
          <AlertTitle>Couldn&apos;t load environments &amp; secrets</AlertTitle>
          <AlertDescription>
            We hit an error reading this workspace&apos;s environments and
            secrets, so the grid below may be incomplete. Reload the page to try
            again — nothing has been deleted.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <h2 className="text-base font-medium">Environments &amp; Secrets</h2>
        <p className="text-sm text-muted-foreground">
          Workspace-root secret keys with per-environment overrides. Sensitive
          values are encrypted at rest. Paste a <code>.env</code> file to
          bulk-import.
        </p>
      </div>

      <EnvironmentsBar
        scope={scope}
        canManage={canManage}
        environments={environments}
        pending={pending}
        start={startTransition}
        createEnvironmentAction={props.createEnvironmentAction}
        setDefaultEnvironmentAction={props.setDefaultEnvironmentAction}
      />

      <SecretsSection
        scope={scope}
        canManage={canManage}
        environments={environments}
        secretKeys={secretKeys}
        pending={pending}
        start={startTransition}
        importEnvAction={props.importEnvAction}
        upsertKeyAction={props.upsertKeyAction}
        setValueAction={props.setValueAction}
        unsetValueAction={props.unsetValueAction}
        deleteKeyAction={props.deleteKeyAction}
      />
    </div>
  );
}

// ── Environments bar ──────────────────────────────────────────────────────────

function EnvironmentsBar({
  scope,
  canManage,
  environments,
  pending,
  start,
  createEnvironmentAction,
  setDefaultEnvironmentAction,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  canManage: boolean;
  environments: EnvironmentSummary[];
  pending: boolean;
  start: (cb: () => void) => void;
  createEnvironmentAction: Props["createEnvironmentAction"];
  setDefaultEnvironmentAction: Props["setDefaultEnvironmentAction"];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Environments</h3>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            className="max-md:h-11"
            disabled={pending}
            onClick={() => setOpen(true)}
          >
            + New environment
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {environments.length === 0 && (
          <span className="text-sm text-muted-foreground">
            No environments yet.
          </span>
        )}
        {environments.map((env) => (
          <div
            key={env.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm"
          >
            <span className="font-medium">{env.name}</span>
            <span className="text-xs text-muted-foreground">{env.slug}</span>
            {env.isDefault ? (
              <Badge variant="secondary" size="sm">
                ★ default
              </Badge>
            ) : (
              canManage && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="max-md:h-11"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await setDefaultEnvironmentAction({
                        ...scope,
                        environmentId: env.id,
                      });
                    })
                  }
                >
                  Set default
                </Button>
              )
            )}
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>
              A named runtime scope (e.g. production, preview). Secrets can
              override per environment.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <label className="text-sm font-medium" htmlFor="env-name">
              Name
            </label>
            <Input
              id="env-name"
              className="max-md:h-11"
              value={name}
              placeholder="Production"
              onChange={(e) => setName(e.target.value)}
            />
            {name && (
              <p className="text-xs text-muted-foreground">
                slug: <code>{slugify(name) || "—"}</code>
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </DialogPanel>
          <DialogFooter className="flex-wrap">
            <Button
              variant="outline"
              className="max-md:h-11"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="max-md:h-11"
              disabled={pending || !name.trim()}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const res = await createEnvironmentAction({
                    ...scope,
                    name: name.trim(),
                    slug: slugify(name),
                  });
                  if (res.ok) {
                    setName("");
                    setOpen(false);
                  } else {
                    setError(res.error);
                  }
                })
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

// ── Secrets section: grid + paste-.env + add-key ──────────────────────────────

function SecretsSection({
  scope,
  canManage,
  environments,
  secretKeys,
  pending,
  start,
  importEnvAction,
  upsertKeyAction,
  setValueAction,
  unsetValueAction,
  deleteKeyAction,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  canManage: boolean;
  environments: EnvironmentSummary[];
  secretKeys: SecretKeySummary[];
  pending: boolean;
  start: (cb: () => void) => void;
  importEnvAction: ImportEnvAction;
  upsertKeyAction: Props["upsertKeyAction"];
  setValueAction: Props["setValueAction"];
  unsetValueAction: Props["unsetValueAction"];
  deleteKeyAction: Props["deleteKeyAction"];
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Inline value editor: { keyId, env: "default" | environmentId }.
  const [editing, setEditing] = useState<{ keyId: string; env: string } | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Secrets</h3>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="max-md:h-11"
              disabled={pending}
              onClick={() => setAddOpen(true)}
            >
              + Add key
            </Button>
            <Button
              size="sm"
              className="max-md:h-11"
              disabled={pending}
              onClick={() => setPasteOpen(true)}
            >
              Paste .env
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border border-border/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Key</th>
              <th className="px-2 py-2 text-left font-medium">Sens</th>
              <th className="px-3 py-2 text-left font-medium">Memo</th>
              {/* Workspace-root value used when an environment has no override.
                  Named "Fallback" (not "Default") so it never collides with an
                  environment whose slug is literally "default". */}
              <th className="px-3 py-2 text-left font-medium">Fallback</th>
              {environments.map((env) => (
                <th key={env.id} className="px-3 py-2 text-left font-medium">
                  {env.slug}
                </th>
              ))}
              {canManage && <th className="px-2 py-2" />}
            </tr>
          </thead>
          <tbody>
            {secretKeys.length === 0 && (
              <tr>
                <td
                  // Key + Sens + Memo + Fallback, one per environment, and the
                  // trailing actions column only when the viewer can manage.
                  colSpan={4 + environments.length + (canManage ? 1 : 0)}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No secrets yet. Click <strong>Paste .env</strong> to
                  bulk-import, or <strong>Add key</strong>.
                </td>
              </tr>
            )}
            {secretKeys.map((k) => (
              <tr
                key={k.id}
                className="border-b border-border/30 last:border-0"
              >
                <td className="px-3 py-2 font-mono text-xs">{k.key}</td>
                <td className="px-2 py-2">{k.sensitive ? "●" : "○"}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {k.memo ?? ""}
                </td>
                <Cell
                  present={k.hasDefault}
                  sensitive={k.sensitive}
                  canManage={canManage}
                  editing={editing?.keyId === k.id && editing.env === "default"}
                  editValue={editValue}
                  setEditValue={setEditValue}
                  onEdit={() => {
                    setEditing({ keyId: k.id, env: "default" });
                    setEditValue("");
                  }}
                  onCancel={() => setEditing(null)}
                  onSave={() =>
                    start(async () => {
                      await upsertKeyAction({
                        ...scope,
                        key: k.key,
                        sensitive: k.sensitive,
                        defaultValue: editValue,
                      });
                      setEditing(null);
                    })
                  }
                />
                {environments.map((env) => {
                  const has = k.overrideEnvironmentIds.includes(env.id);
                  return (
                    <Cell
                      key={env.id}
                      present={has}
                      sensitive={k.sensitive}
                      canManage={canManage}
                      editing={
                        editing?.keyId === k.id && editing.env === env.id
                      }
                      editValue={editValue}
                      setEditValue={setEditValue}
                      inherit={!has}
                      onEdit={() => {
                        setEditing({ keyId: k.id, env: env.id });
                        setEditValue("");
                      }}
                      onCancel={() => setEditing(null)}
                      onClear={
                        has
                          ? () =>
                              start(async () => {
                                await unsetValueAction({
                                  ...scope,
                                  keyId: k.id,
                                  environmentId: env.id,
                                });
                                setEditing(null);
                              })
                          : undefined
                      }
                      onSave={() =>
                        start(async () => {
                          await setValueAction({
                            ...scope,
                            keyId: k.id,
                            environmentId: env.id,
                            value: editValue,
                          });
                          setEditing(null);
                        })
                      }
                    />
                  );
                })}
                {canManage && (
                  <td className="px-2 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="max-md:h-11"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          await deleteKeyAction({ ...scope, keyId: k.id });
                        })
                      }
                    >
                      Delete
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        ● sensitive (encrypted) · ○ plain config · ‹inherit› falls back to the
        Fallback value. Reveal/export a plaintext value via the API or{" "}
        <code>oxagen secret reveal</code> (audited).
      </p>

      {canManage && (
        <>
          <PasteEnvDialog
            scope={scope}
            environments={environments}
            open={pasteOpen}
            setOpen={setPasteOpen}
            importEnvAction={importEnvAction}
          />
          <AddKeyDialog
            scope={scope}
            open={addOpen}
            setOpen={setAddOpen}
            upsertKeyAction={upsertKeyAction}
          />
        </>
      )}
    </section>
  );
}

function Cell({
  present,
  sensitive,
  canManage,
  inherit,
  editing,
  editValue,
  setEditValue,
  onEdit,
  onCancel,
  onSave,
  onClear,
}: {
  present: boolean;
  sensitive: boolean;
  canManage: boolean;
  inherit?: boolean;
  editing: boolean;
  editValue: string;
  setEditValue: (v: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onClear?: () => void;
}) {
  if (editing) {
    return (
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <Input
            size="sm"
            autoFocus
            type={sensitive ? "password" : "text"}
            value={editValue}
            placeholder="value"
            onChange={(e) => setEditValue(e.target.value)}
            className="h-7 w-36 max-md:h-11"
          />
          <Button
            variant="ghost"
            size="xs"
            className="max-md:h-11"
            onClick={onSave}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="max-md:h-11"
            onClick={onCancel}
          >
            ✕
          </Button>
        </div>
      </td>
    );
  }
  return (
    <td className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {present ? (
          <span className="font-mono text-xs">
            {sensitive ? "••••••" : "set"}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {inherit ? "‹inherit›" : "—"}
          </span>
        )}
        {canManage && (
          <button
            type="button"
            className="inline-flex items-center text-xs text-muted-foreground underline-offset-2 hover:underline max-md:min-h-11"
            onClick={onEdit}
          >
            {present ? "edit" : "set"}
          </button>
        )}
        {canManage && present && onClear && (
          <button
            type="button"
            className="inline-flex items-center text-xs text-muted-foreground underline-offset-2 hover:underline max-md:min-h-11"
            onClick={onClear}
          >
            clear
          </button>
        )}
      </div>
    </td>
  );
}

// ── Paste .env dialog (the headline feature) ──────────────────────────────────

function PasteEnvDialog({
  scope,
  environments,
  open,
  setOpen,
  importEnvAction,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  environments: EnvironmentSummary[];
  open: boolean;
  setOpen: (v: boolean) => void;
  importEnvAction: ImportEnvAction;
}) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>("default"); // "default" | environmentId
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setText("");
    setTarget("default");
    setPreview(null);
    setError(null);
  };

  const environmentId = target === "default" ? null : target;

  const runImport = (commit: boolean) =>
    startTransition(async () => {
      setError(null);
      const res = await importEnvAction({
        ...scope,
        text,
        environmentId,
        commit,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.committed) {
        reset();
        setOpen(false);
      } else {
        setPreview(res.rows);
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste .env</DialogTitle>
          <DialogDescription>
            Paste the contents of a <code>.env</code> file. Comments and{" "}
            <code>export </code> are ignored, surrounding quotes stripped. New
            keys are stored encrypted. Review the preview before importing.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Target:</span>
            <select
              className="max-md:h-11 rounded-md border border-border/50 bg-background px-2 py-1 text-sm"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setPreview(null);
              }}
            >
              <option value="default">Workspace default values</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name} ({env.slug}) overrides
                </option>
              ))}
            </select>
          </div>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            placeholder={
              '# paste here\nDATABASE_URL="postgres://…"\nexport OPENAI_API_KEY=sk-…\nLOG_LEVEL=info'
            }
            rows={8}
            className="font-mono text-xs"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          {preview && (
            <div className="rounded-md border border-border/40">
              <div className="border-b border-border/40 px-3 py-1.5 text-xs text-muted-foreground">
                {preview.length} parsed ·{" "}
                {preview.filter((r) => r.isNewKey).length} new ·{" "}
                {preview.filter((r) => !r.isNewKey).length} existing
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {preview.map((r) => (
                      <tr
                        key={r.key}
                        className="border-b border-border/20 last:border-0"
                      >
                        <td className="px-3 py-1 font-mono">
                          <span
                            className={
                              r.isNewKey
                                ? "text-success"
                                : "text-muted-foreground"
                            }
                          >
                            {r.isNewKey ? "+ " : "~ "}
                          </span>
                          {r.key}
                        </td>
                        <td className="px-2 py-1">{r.sensitive ? "●" : "○"}</td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {r.target}
                        </td>
                        <td className="px-3 py-1 text-muted-foreground">
                          {r.isNewKey
                            ? "new"
                            : r.willOverride
                              ? "override"
                              : "set"}
                        </td>
                      </tr>
                    ))}
                    {preview.length === 0 && (
                      <tr>
                        <td className="px-3 py-2 text-muted-foreground">
                          No valid keys parsed.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </DialogPanel>
        <DialogFooter className="flex-wrap">
          <Button
            variant="outline"
            className="max-md:h-11"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          {!preview ? (
            <Button
              className="max-md:h-11"
              disabled={pending || !text.trim()}
              onClick={() => runImport(false)}
            >
              Preview
            </Button>
          ) : (
            <Button
              className="max-md:h-11"
              disabled={pending || preview.length === 0}
              onClick={() => runImport(true)}
            >
              Import {preview.length} key{preview.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── Add single key dialog ─────────────────────────────────────────────────────

function AddKeyDialog({
  scope,
  open,
  setOpen,
  upsertKeyAction,
}: {
  scope: { orgSlug: string; workspaceSlug: string };
  open: boolean;
  setOpen: (v: boolean) => void;
  upsertKeyAction: Props["upsertKeyAction"];
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [memo, setMemo] = useState("");
  const [sensitive, setSensitive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setKey("");
    setValue("");
    setMemo("");
    setSensitive(true);
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add secret key</DialogTitle>
          <DialogDescription>
            A workspace-root key with a default value. Sensitive keys are
            encrypted at rest.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <Input
            value={key}
            placeholder="DATABASE_URL"
            className="max-md:h-11 font-mono"
            onChange={(e) => setKey(e.target.value)}
          />
          <Input
            type={sensitive ? "password" : "text"}
            value={value}
            className="max-md:h-11"
            placeholder="default value (optional)"
            onChange={(e) => setValue(e.target.value)}
          />
          <Input
            value={memo}
            className="max-md:h-11"
            placeholder="memo (optional)"
            onChange={(e) => setMemo(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={sensitive} onCheckedChange={setSensitive} />
            Sensitive (encrypt at rest)
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </DialogPanel>
        <DialogFooter className="flex-wrap">
          <Button
            variant="outline"
            className="max-md:h-11"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            className="max-md:h-11"
            disabled={pending || !key.trim()}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const res = await upsertKeyAction({
                  ...scope,
                  key: key.trim(),
                  sensitive,
                  memo: memo.trim() || null,
                  defaultValue: value === "" ? undefined : value,
                });
                if (res.ok) {
                  reset();
                  setOpen(false);
                } else {
                  setError(res.error);
                }
              })
            }
          >
            Add key
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
