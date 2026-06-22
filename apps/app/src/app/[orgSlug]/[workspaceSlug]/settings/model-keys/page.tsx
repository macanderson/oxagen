/**
 * page.tsx — Workspace → Settings → Model Keys (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: workspace.modelKeys.list + workspace.modelKeys.add
 *                 capabilities (BYOK at workspace scope — workspace_model_keys table).
 *
 * BYOK keys override the platform defaults (Vercel AI Gateway) for every
 * agent run in this workspace, billed at cost with no platform margin.
 */
import { Info, KeyRound, Plus, Check, AlertTriangle, Trash2, ShieldCheck } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type KeyStatus = "active" | "invalid" | "expired";

interface MockModelKey {
  id: string;
  provider: string;
  providerLabel: string;
  maskedKey: string;
  status: KeyStatus;
  addedAt: string;
  lastUsedAt: string | null;
  note: string | null;
}

const MOCK_MODEL_KEYS: MockModelKey[] = [
  {
    id: "mk-01",
    provider: "anthropic",
    providerLabel: "Anthropic",
    maskedKey: "sk-ant-…Z9wX",
    status: "active",
    addedAt: "2026-05-20",
    lastUsedAt: "2026-06-06",
    note: "Workspace BYOK — bypasses Oxagen gateway credits",
  },
  {
    id: "mk-02",
    provider: "openai",
    providerLabel: "OpenAI",
    maskedKey: "sk-proj-…4Q3R",
    status: "invalid",
    addedAt: "2026-06-01",
    lastUsedAt: null,
    note: null,
  },
];

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google AI" },
  { id: "xai", label: "xAI" },
  { id: "deepseek", label: "DeepSeek" },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<KeyStatus, { label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; className: string }> = {
  active: {
    label: "Active",
    icon: Check,
    className: "text-success",
  },
  invalid: {
    label: "Invalid",
    icon: AlertTriangle,
    className: "text-error",
  },
  expired: {
    label: "Expired",
    icon: AlertTriangle,
    className: "text-warning",
  },
};

function ModelKeyRow({ mk }: { mk: MockModelKey }) {
  const status = STATUS_CONFIG[mk.status];
  const StatusIcon = status.icon;
  return (
    <li className="flex items-start justify-between gap-4 border-b border-border/40 px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{mk.providerLabel}</span>
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${status.className}`}>
            <StatusIcon className="h-3 w-3" aria-hidden="true" />
            {status.label}
          </span>
        </div>
        <code className="text-[11px] font-mono text-muted-foreground">{mk.maskedKey}</code>
        {mk.note && <p className="text-[11px] text-muted-foreground">{mk.note}</p>}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>Added {mk.addedAt}</span>
          {mk.lastUsedAt && <span>Last used {mk.lastUsedAt}</span>}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Remove ${mk.providerLabel} key`}
        className="flex-shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsModelKeysPage() {
  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Section heading */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Model keys</p>
            <p className="text-xs text-muted-foreground">
              Bring your own keys (BYOK) at workspace scope. Keys override the Oxagen
              AI Gateway for every agent run here — billed at cost with no platform margin.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add key
        </button>
      </div>

      {/* Security callout */}
      <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/12 px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
        <div className="text-xs text-warning">
          <p className="font-semibold">Keys are stored encrypted at rest.</p>
          <p className="mt-0.5">
            Only the last four characters of each key are displayed after saving.
            Keys are never logged or transmitted in plain text.
          </p>
        </div>
      </div>

      {/* Existing keys */}
      {MOCK_MODEL_KEYS.length > 0 ? (
        <div className="rounded-lg border border-border/60">
          <div className="border-b border-border/60 px-4 py-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Active keys ({MOCK_MODEL_KEYS.length})
            </span>
          </div>
          <ul>
            {MOCK_MODEL_KEYS.map((mk) => (
              <ModelKeyRow key={mk.id} mk={mk} />
            ))}
          </ul>
        </div>
      ) : null}

      {/* Supported providers */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Supported providers</p>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <span
              key={p.id}
              className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {p.label}
            </span>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Only workspace owners and admins can manage model keys.
        Keys rotate automatically when a new key for the same provider is added.
      </p>
    </div>
  );
}
