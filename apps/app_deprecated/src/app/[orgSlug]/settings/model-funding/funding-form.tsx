"use client";
/**
 * funding-form.tsx — Organization → Settings → Model funding (ADR-053 §2–3).
 *
 * Three blocks: who pays today, the org's own vendor key (test / save /
 * remove), and the monthly cap on assistant usage Oxagen pays for. The key
 * field is write-only: masked, never rendered back, cleared after a save.
 * "Remove key" confirms inline with a second button rather than a browser
 * `confirm()` dialog, matching revoke-own-session-button.tsx.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Save, Trash2, FlaskConical } from "lucide-react";
import type {
  ModelCredentialProvider,
  ModelCredentialView,
} from "@oxagen/oxagen/contracts/org.model_credential.shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  CredentialActionResult,
  SpendCapActionResult,
  VerifyActionResult,
} from "./funding-actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FundingFormProps {
  orgSlug: string;
  /** Redacted credential view; null when the viewer may not read it. */
  view: ModelCredentialView | null;
  /** Monthly cap in credit cents; null means no cap. */
  capCents: number | null;
  /** True when the caller's org role is owner or admin. */
  canEdit: boolean;
  /** Set when the page could not load the current status. */
  loadError?: string | null;
  setAction: (input: {
    provider: string;
    apiKey: string;
  }) => Promise<CredentialActionResult>;
  verifyAction: (input: {
    provider?: string;
    apiKey?: string;
  }) => Promise<VerifyActionResult>;
  deleteAction: () => Promise<CredentialActionResult>;
  capAction: (capCents: number | null) => Promise<SpendCapActionResult>;
}

const PROVIDER_LABELS: Record<ModelCredentialProvider, string> = {
  openrouter: "OpenRouter",
  gateway: "Vercel AI Gateway",
};

const PROVIDER_OPTIONS = Object.entries(PROVIDER_LABELS) as [
  ModelCredentialProvider,
  string,
][];

const SELECT_CLASS =
  "w-full max-w-xs rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function centsToCredits(cents: number): string {
  return (cents / 100).toFixed(2);
}

function creditsToCents(value: string): number | null {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

function providerLabel(provider: ModelCredentialProvider | null): string {
  return provider ? PROVIDER_LABELS[provider] : "your vendor";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FundingForm({
  view: initialView,
  capCents: initialCapCents,
  canEdit,
  loadError = null,
  setAction,
  verifyAction,
  deleteAction,
  capAction,
}: FundingFormProps): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  // ── Credential state ──────────────────────────────────────────────────────
  const [view, setView] = React.useState<ModelCredentialView | null>(
    initialView,
  );
  const [provider, setProvider] = React.useState<ModelCredentialProvider>(
    initialView?.provider ?? "openrouter",
  );
  const [apiKey, setApiKey] = React.useState("");
  const [keyBusy, setKeyBusy] = React.useState<"test" | "save" | null>(null);
  const [keyError, setKeyError] = React.useState<string | null>(null);
  const [keyNotice, setKeyNotice] = React.useState<string | null>(null);
  const [removeStatus, setRemoveStatus] = React.useState<
    "idle" | "confirming" | "removing"
  >("idle");

  // ── Cap state ─────────────────────────────────────────────────────────────
  const [noCap, setNoCap] = React.useState(initialCapCents === null);
  const [capValue, setCapValue] = React.useState(
    initialCapCents === null ? "" : centsToCredits(initialCapCents),
  );
  const [capStatus, setCapStatus] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [capError, setCapError] = React.useState<string | null>(null);

  const configured = view?.configured === true;
  const keyReady = apiKey.trim().length > 0;
  const busy = pending || keyBusy !== null || removeStatus === "removing";

  // ── Key handlers ──────────────────────────────────────────────────────────

  const handleTest = () => {
    setKeyBusy("test");
    setKeyError(null);
    setKeyNotice(null);
    const candidate = keyReady ? { provider, apiKey: apiKey.trim() } : {};
    startTransition(async () => {
      const result = await verifyAction(candidate);
      setKeyBusy(null);
      if (!result.ok) {
        setKeyError(result.error);
        return;
      }
      const v = result.verification;
      if (v.ok) {
        setKeyNotice(
          `${PROVIDER_LABELS[v.provider]} accepted the key (${v.latencyMs} ms).`,
        );
      } else {
        setKeyError(
          `${PROVIDER_LABELS[v.provider]} rejected the key: ${v.error ?? "no reason given"}`,
        );
      }
    });
  };

  const handleSave = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!keyReady) {
      setKeyError("Enter the API key.");
      return;
    }
    setKeyBusy("save");
    setKeyError(null);
    setKeyNotice(null);
    startTransition(async () => {
      const result = await setAction({ provider, apiKey: apiKey.trim() });
      setKeyBusy(null);
      if (!result.ok) {
        setKeyError(result.error);
        return;
      }
      setView(result.view);
      setApiKey("");
      setKeyNotice("Key saved. The assistant now runs on your key.");
      router.refresh();
    });
  };

  const handleRemove = () => {
    if (removeStatus === "removing") return;
    if (removeStatus !== "confirming") {
      setRemoveStatus("confirming");
      return;
    }
    setRemoveStatus("removing");
    setKeyError(null);
    setKeyNotice(null);
    startTransition(async () => {
      const result = await deleteAction();
      setRemoveStatus("idle");
      if (!result.ok) {
        setKeyError(result.error);
        return;
      }
      setView(result.view);
      setKeyNotice("Key removed. The assistant now runs on Oxagen's key.");
      router.refresh();
    });
  };

  // ── Cap handler ───────────────────────────────────────────────────────────

  const handleCapSave = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCapError(null);
    let cents: number | null = null;
    if (!noCap) {
      cents = creditsToCents(capValue);
      if (cents === null) {
        setCapStatus("error");
        setCapError("Enter a cap of zero or more credits, or choose no cap.");
        return;
      }
    }
    setCapStatus("saving");
    startTransition(async () => {
      const result = await capAction(cents);
      if (!result.ok) {
        setCapStatus("error");
        setCapError(result.error);
        return;
      }
      setCapStatus("saved");
      setNoCap(result.capCents === null);
      setCapValue(
        result.capCents === null ? "" : centsToCredits(result.capCents),
      );
      router.refresh();
      setTimeout(() => setCapStatus("idle"), 2000);
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const lastVerified = formatTimestamp(view?.lastVerifiedAt ?? null);
  const rotated = formatTimestamp(view?.rotatedAt ?? null);

  return (
    <div className="flex max-w-lg flex-col gap-8">
      {/* Who pays */}
      <section
        aria-labelledby="funding-status-heading"
        className="flex flex-col gap-2 rounded-md border border-border/60 p-4"
      >
        <h2 id="funding-status-heading" className="text-sm font-semibold">
          Who pays for the assistant
        </h2>
        {loadError ? (
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
        ) : !canEdit ? (
          <p className="text-xs text-muted-foreground" role="note">
            Only organization owners and admins can see or change who pays for
            the assistant.
          </p>
        ) : configured ? (
          <div className="flex flex-col gap-1" data-testid="funding-status">
            <p className="text-sm">
              <KeyRound
                className="mr-1.5 inline h-4 w-4 align-text-bottom"
                aria-hidden="true"
              />
              Your key ({providerLabel(view?.provider ?? null)}, ends in{" "}
              <span className="font-mono">{view?.keyHint ?? "????"}</span>)
            </p>
            <p className="text-xs text-muted-foreground">
              {lastVerified
                ? `Last verified ${lastVerified}.`
                : "Not verified yet."}{" "}
              {rotated ? `Last changed ${rotated}.` : null}
              {view?.status === "disabled" ? " This key is disabled." : null}
            </p>
            <p className="text-xs text-muted-foreground">
              Tokens run on your vendor account. Oxagen bills nothing for them.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1" data-testid="funding-status">
            <p className="text-sm">
              Oxagen&rsquo;s key &mdash; assistant usage is billed to your
              credits.
            </p>
            <p className="text-xs text-muted-foreground">
              Add your own key below to pay the vendor directly instead.
            </p>
          </div>
        )}
      </section>

      {/* Own key */}
      <form
        onSubmit={handleSave}
        className="flex flex-col gap-4"
        aria-label="Your model vendor key"
        noValidate
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Your own key</h2>
          <p className="text-xs text-muted-foreground">
            Paste a key from OpenRouter or Vercel AI Gateway. It is stored
            encrypted and never shown again. Saving a new key replaces the old
            one. An OpenRouter key covers chat models only, so embeddings stay
            on Oxagen&rsquo;s key and count against your credits.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="funding-provider">Provider</Label>
          <select
            id="funding-provider"
            value={provider}
            onChange={(e) =>
              setProvider(e.target.value as ModelCredentialProvider)
            }
            disabled={busy || !canEdit}
            className={SELECT_CLASS}
          >
            {PROVIDER_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="funding-api-key">API key</Label>
          <Input
            id="funding-api-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={configured ? "Paste a new key to replace it" : "sk-…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={busy || !canEdit}
            className="font-mono"
          />
        </div>

        {keyError && (
          <p className="text-sm text-destructive" role="alert">
            {keyError}
          </p>
        )}
        {keyNotice && (
          <p className="text-sm text-muted-foreground" role="status">
            {keyNotice}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={busy || !canEdit || (!keyReady && !configured)}
            startIcon={<FlaskConical className="h-4 w-4" aria-hidden="true" />}
          >
            {keyBusy === "test"
              ? "Testing…"
              : keyReady
                ? "Test key"
                : "Test stored key"}
          </Button>
          <Button
            type="submit"
            variant="gradient"
            disabled={busy || !canEdit || !keyReady}
            startIcon={<Save className="h-4 w-4" aria-hidden="true" />}
          >
            {keyBusy === "save" ? "Saving…" : "Save key"}
          </Button>
          {configured && removeStatus === "confirming" ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                Remove your key and switch to Oxagen&rsquo;s?
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleRemove}
                disabled={busy}
              >
                Confirm remove
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRemoveStatus("idle")}
                disabled={busy}
              >
                Cancel
              </Button>
            </span>
          ) : configured ? (
            <Button
              type="button"
              variant="ghost"
              onClick={handleRemove}
              disabled={busy || !canEdit}
              startIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
            >
              {removeStatus === "removing" ? "Removing…" : "Remove key"}
            </Button>
          ) : null}
        </div>
      </form>

      {/* Cap */}
      <form
        onSubmit={handleCapSave}
        className="flex flex-col gap-4"
        aria-label="Assistant usage cap"
        noValidate
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">
            Monthly cap on assistant usage paid by Oxagen (credits)
          </h2>
          <p className="text-xs text-muted-foreground">
            When the assistant runs on Oxagen&rsquo;s key, it stops for the rest
            of the month once this much has been spent. The cap does not apply
            while your own key is stored.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="funding-cap">Cap (credits per month)</Label>
          <Input
            id="funding-cap"
            name="capCredits"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={capValue}
            onChange={(e) => setCapValue(e.target.value)}
            disabled={busy || !canEdit || noCap || capStatus === "saving"}
            placeholder="25.00"
            className="max-w-xs"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="noCap"
            checked={noCap}
            onChange={(e) => setNoCap(e.target.checked)}
            disabled={busy || !canEdit || capStatus === "saving"}
            className="size-4 accent-primary"
          />
          No cap
        </label>

        {capStatus === "error" && capError && (
          <p className="text-sm text-destructive" role="alert">
            {capError}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="gradient"
            disabled={
              busy ||
              !canEdit ||
              capStatus === "saving" ||
              (!noCap && capValue.trim() === "")
            }
            startIcon={<Save className="h-4 w-4" aria-hidden="true" />}
          >
            {capStatus === "saving" ? "Saving…" : "Save cap"}
          </Button>
          {capStatus === "saved" && (
            <span className="text-xs text-muted-foreground" role="status">
              Saved
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
