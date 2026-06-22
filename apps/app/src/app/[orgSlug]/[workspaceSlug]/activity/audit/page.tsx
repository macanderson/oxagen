/**
 * page.tsx — Workspace → Activity → Audit (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: activity.audit.list capability (ClickHouse workspace_audit_events).
 *
 * Every capability invocation is recorded with principal, outcome, and a
 * tamper-evident hash. This page shows a workspace-scoped slice.
 */
import { Info, ScrollText, User, Bot, Key, CheckCircle2, XCircle, Hash, type LucideIcon } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type AuditOutcome = "success" | "denied" | "error";
type AuditPrincipalKind = "user" | "agent" | "api_key";

interface MockAuditEvent {
  id: string;
  capability: string;
  principalKind: AuditPrincipalKind;
  principalName: string;
  outcome: AuditOutcome;
  durationMs: number;
  eventHash: string;
  occurredAt: string;
  detail: string | null;
}

const MOCK_AUDIT: MockAuditEvent[] = [
  {
    id: "aud-01",
    capability: "workspace.model.settings.write",
    principalKind: "user",
    principalName: "Mac Anderson",
    outcome: "success",
    durationMs: 43,
    eventHash: "a3f9d2c1",
    occurredAt: "2026-06-06 14:30",
    detail: null,
  },
  {
    id: "aud-02",
    capability: "media.image.generate",
    principalKind: "user",
    principalName: "Mac Anderson",
    outcome: "success",
    durationMs: 12_100,
    eventHash: "7b1e4a80",
    occurredAt: "2026-06-06 13:21",
    detail: "model=openai/gpt-image-1, tokens=512",
  },
  {
    id: "aud-03",
    capability: "knowledge.sources.sync",
    principalKind: "agent",
    principalName: "Data Ingestion Agent",
    outcome: "error",
    durationMs: 3_200,
    eventHash: "c8d52f3a",
    occurredAt: "2026-06-06 12:05",
    detail: "OAuth token expired for Google Drive source",
  },
  {
    id: "aud-04",
    capability: "workspace.brandKits.create",
    principalKind: "user",
    principalName: "Mac Anderson",
    outcome: "success",
    durationMs: 28,
    eventHash: "f45a9e12",
    occurredAt: "2026-06-06 11:00",
    detail: null,
  },
  {
    id: "aud-05",
    capability: "workspace.members.invite",
    principalKind: "api_key",
    principalName: "CI Pipeline Key",
    outcome: "denied",
    durationMs: 5,
    eventHash: "2d87bc44",
    occurredAt: "2026-06-05 23:15",
    detail: "Insufficient role — required: admin, caller: viewer",
  },
  {
    id: "aud-06",
    capability: "conversation.message.create",
    principalKind: "user",
    principalName: "Mac Anderson",
    outcome: "success",
    durationMs: 8_320,
    eventHash: "9f3c7d6b",
    occurredAt: "2026-06-05 17:45",
    detail: "model=anthropic/claude-sonnet-4.6, toolCalls=3",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const OUTCOME_CONFIG: Record<AuditOutcome, { icon: LucideIcon; className: string; label: string }> = {
  success: {
    icon: CheckCircle2,
    className: "text-success",
    label: "Success",
  },
  denied: {
    icon: XCircle,
    className: "text-warning",
    label: "Denied",
  },
  error: {
    icon: XCircle,
    className: "text-error",
    label: "Error",
  },
};

const PRINCIPAL_ICONS: Record<AuditPrincipalKind, LucideIcon> = {
  user: User,
  agent: Bot,
  api_key: Key,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AuditRow({ event }: { event: MockAuditEvent }) {
  const outcome = OUTCOME_CONFIG[event.outcome];
  const OutcomeIcon = outcome.icon;
  const PrincipalIcon = PRINCIPAL_ICONS[event.principalKind];

  return (
    <li className="flex items-start gap-3 border-b border-border/40 px-4 py-3.5 last:border-b-0 hover:bg-muted/30 transition-colors">
      <OutcomeIcon
        className={`mt-0.5 h-4 w-4 flex-shrink-0 ${outcome.className}`}
        aria-label={outcome.label}
      />
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <code className="text-xs font-mono font-medium text-foreground">{event.capability}</code>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <PrincipalIcon className="h-3 w-3" aria-hidden="true" />
            {event.principalName}
          </span>
          <span>{formatDuration(event.durationMs)}</span>
          <span>{event.occurredAt}</span>
          <span className="flex items-center gap-1 font-mono">
            <Hash className="h-3 w-3" aria-hidden="true" />
            {event.eventHash}
          </span>
        </div>
        {event.detail && (
          <p className="text-[11px] text-muted-foreground">{event.detail}</p>
        )}
      </div>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ActivityAuditPage() {
  const successCount = MOCK_AUDIT.filter((e) => e.outcome === "success").length;
  const deniedCount = MOCK_AUDIT.filter((e) => e.outcome === "denied").length;
  const errorCount = MOCK_AUDIT.filter((e) => e.outcome === "error").length;

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Section heading */}
      <div className="flex items-start gap-3">
        <ScrollText className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">Audit log</p>
          <p className="text-xs text-muted-foreground">
            Workspace-scoped slice of the org-wide audit log. Every capability invocation is
            recorded with principal, outcome, duration, and a tamper-evident hash.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Successful (24h)</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{successCount}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Denied (24h)</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{deniedCount}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Errors (24h)</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{errorCount}</span>
        </div>
      </div>

      {/* Audit table */}
      <div className="rounded-lg border border-border/60">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <ScrollText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground">Recent events</span>
          <span className="ml-auto text-xs text-muted-foreground">Last 24 hours</span>
        </div>
        <ul>
          {MOCK_AUDIT.map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">
        Audit logs are retained for 1 year on all plans. Event hashes are SHA-256 (first 8 hex chars shown).
        Export to SIEM via the API or the audit.events.export capability.
      </p>
    </div>
  );
}
