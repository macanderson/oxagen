"use client";

import { useState, useTransition } from "react";
import {
  Plus,
  RotateCw,
  Trash2,
  Copy,
  Check,
  Clock,
  Layers,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useCopyToClipboard } from "@/components/ui/copy-button";
import { Panel } from "@/components/ui/panel";
import { formatDate } from "@/lib/utils";
import {
  createApiKeyAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
} from "./api-key";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  publicId: string;
  name: string;
  keyPrefix: string;
  scope: unknown;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

interface TokensPanelProps {
  orgSlug: string;
  keys: ApiKeyRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function obfuscatePrefix(prefix: string): string {
  return `${prefix}${"•".repeat(32)}`;
}

// ── Create dialog ─────────────────────────────────────────────────────────────

function CreateKeyDialog({
  orgSlug,
  onCreated,
}: {
  orgSlug: string;
  onCreated: (rawKey: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await createApiKeyAction({ orgSlug, name: name.trim() });
        onCreated(result.rawKey, result.name);
        setName("");
        setOpen(false);
      } catch (e) {
        setError(messageFor(e));
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Create token
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      {error ? (
        <p
          role="alert"
          data-testid="api-key-create-error"
          className="basis-full text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="key-name"
          className="text-xs font-medium text-muted-foreground"
        >
          Token name
        </label>
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. CI Pipeline"
          className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          autoFocus
          disabled={isPending}
        />
      </div>
      <button
        type="submit"
        disabled={isPending || !name.trim()}
        className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {isPending ? "Creating…" : "Create"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="h-8 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
      >
        Cancel
      </button>
    </form>
  );
}

// ── Raw key display (shown once after creation/rotation) ──────────────────────

function RawKeyBanner({ rawKey, label }: { rawKey: string; label: string }) {
  const { copied, copy } = useCopyToClipboard({ timeout: 2000 });

  function copyKey() {
    void copy(rawKey);
  }

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
      <p className="text-xs font-semibold text-warning mb-1">
        Copy your token now — it won&apos;t be shown again
      </p>
      <p className="text-xs text-muted-foreground mb-2">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
          {rawKey}
        </code>
        <button
          type="button"
          onClick={copyKey}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
          aria-label="Copy token"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

// ── Key row (active) ──────────────────────────────────────────────────────────

/**
 * A server action rejected inside `startTransition` has nowhere to surface:
 * React swallows it, the transition ends, and the UI simply does not change.
 * Every action on this panel did that, which is why a rotation that failed
 * looked identical to one that succeeded and left the previous secret on
 * screen (#1225).
 */
function messageFor(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong.";
}

function ActiveKeyRow({
  keyRow,
  orgSlug,
  onRotated,
}: {
  keyRow: ApiKeyRow;
  orgSlug: string;
  onRotated: (rawKey: string, name: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleRevoke() {
    setError(null);
    startTransition(async () => {
      try {
        await revokeApiKeyAction({ orgSlug, keyPublicId: keyRow.publicId });
        setConfirmRevoke(false);
      } catch (e) {
        setError(messageFor(e));
      }
    });
  }

  function handleRotate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await rotateApiKeyAction({
          orgSlug,
          keyPublicId: keyRow.publicId,
        });
        onRotated(result.rawKey, result.name);
      } catch (e) {
        setError(messageFor(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {keyRow.name}
        </p>
        <p className="font-mono text-xs text-muted-foreground truncate">
          {obfuscatePrefix(keyRow.keyPrefix)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {keyRow.lastUsedAt
            ? `Last used ${formatDate(keyRow.lastUsedAt)}`
            : "Never used"}
        </span>
        {keyRow.expiresAt ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Expires {formatDate(keyRow.expiresAt)}
          </span>
        ) : (
          <Badge variant="outline" className="text-xs">
            No expiry
          </Badge>
        )}
        <button
          type="button"
          onClick={handleRotate}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
          title="Rotate key"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Rotate
        </button>
        {confirmRevoke ? (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={handleRevoke}
              disabled={isPending}
              className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRevoke(true)}
            disabled={isPending}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
            title="Revoke key"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Revoke
          </button>
        )}
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="api-key-action-error"
          className="text-xs text-destructive sm:basis-full"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function TokensPanel({ orgSlug, keys }: TokensPanelProps) {
  const [newKey, setNewKey] = useState<{ rawKey: string; name: string } | null>(
    null,
  );

  const now = new Date();
  const active = keys.filter(
    (k) => !k.deletedAt && (!k.expiresAt || new Date(k.expiresAt) > now),
  );
  const revoked = keys.filter(
    (k) => k.deletedAt || (k.expiresAt && new Date(k.expiresAt) <= now),
  );

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title="API tokens"
        actions={
          <CreateKeyDialog
            orgSlug={orgSlug}
            onCreated={(rawKey, name) => setNewKey({ rawKey, name })}
          />
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Scoped service-principal credentials for programmatic access.
        </p>

        {newKey && (
          <div className="mb-4">
            <RawKeyBanner rawKey={newKey.rawKey} label={newKey.name} />
          </div>
        )}

        {active.length === 0 && revoked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No API tokens yet. Create one above to get started.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {active.length > 0 && (
              <>
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-1">
                  Active
                </p>
                {active.map((key) => (
                  <ActiveKeyRow
                    key={key.publicId}
                    keyRow={key}
                    orgSlug={orgSlug}
                    onRotated={(rawKey, name) => setNewKey({ rawKey, name })}
                  />
                ))}
              </>
            )}

            {revoked.length > 0 && (
              <>
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mt-4 mb-1">
                  Revoked / expired
                </p>
                {revoked.map((key) => (
                  <div
                    key={key.publicId}
                    className="flex flex-col gap-1.5 rounded-xl border border-border/40 bg-muted/10 px-4 py-3 opacity-60 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {key.name}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground truncate">
                        {obfuscatePrefix(key.keyPrefix)}
                      </p>
                    </div>
                    <Badge variant="muted" className="shrink-0 text-xs">
                      {key.deletedAt ? "Revoked" : "Expired"}
                    </Badge>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
