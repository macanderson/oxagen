/**
 * page.tsx — Workspace → Automation → Triggers (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: automation.triggers.list + automation.triggers.create
 *                 capabilities (workspace_triggers table, Postgres).
 *
 * Triggers are cause-to-effect rules. Cause can be an event, a schedule,
 * a webhook, or a manual invocation. Each trigger acts as a named principal.
 */
import {
  Info,
  Zap,
  Plus,
  Calendar,
  Webhook,
  Play,
  Radio,
  MoreHorizontal,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type TriggerStatus = "active" | "paused" | "draft";
type TriggerKind = "schedule" | "event" | "webhook" | "manual";

interface MockTrigger {
  id: string;
  name: string;
  kind: TriggerKind;
  status: TriggerStatus;
  playbookName: string;
  scheduleLabel: string | null;
  eventName: string | null;
  webhookUrl: string | null;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
}

const MOCK_TRIGGERS: MockTrigger[] = [
  {
    id: "trg-01",
    name: "Weekly graph audit",
    kind: "schedule",
    status: "active",
    playbookName: "Monthly knowledge graph audit",
    scheduleLabel: "Every Monday at 09:00 UTC",
    eventName: null,
    webhookUrl: null,
    fireCount: 12,
    lastFiredAt: "2026-06-03 09:00",
    createdAt: "2026-05-01",
  },
  {
    id: "trg-02",
    name: "On new source connected",
    kind: "event",
    status: "active",
    playbookName: "New source onboarding",
    scheduleLabel: null,
    eventName: "knowledge.source.created",
    webhookUrl: null,
    fireCount: 7,
    lastFiredAt: "2026-06-05 14:30",
    createdAt: "2026-05-10",
  },
  {
    id: "trg-03",
    name: "External CI webhook",
    kind: "webhook",
    status: "paused",
    playbookName: "Billing anomaly investigation",
    scheduleLabel: null,
    eventName: null,
    webhookUrl: "https://oxagen-v2-api.vercel.app/v1/hooks/trg-03",
    fireCount: 2,
    lastFiredAt: "2026-05-28 08:00",
    createdAt: "2026-05-20",
  },
  {
    id: "trg-04",
    name: "Manual competitor sweep",
    kind: "manual",
    status: "draft",
    playbookName: "Competitor analysis weekly",
    scheduleLabel: null,
    eventName: null,
    webhookUrl: null,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: "2026-06-04",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<TriggerStatus, { badgeClass: string; label: string }> = {
  active: {
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Active",
  },
  paused: {
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    label: "Paused",
  },
  draft: {
    badgeClass: "bg-muted text-muted-foreground",
    label: "Draft",
  },
};

const KIND_CONFIG: Record<TriggerKind, { icon: React.ElementType; label: string }> = {
  schedule: { icon: Calendar, label: "Schedule" },
  event: { icon: Radio, label: "Event" },
  webhook: { icon: Webhook, label: "Webhook" },
  manual: { icon: Play, label: "Manual" },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function TriggerCard({ trigger }: { trigger: MockTrigger }) {
  const status = STATUS_CONFIG[trigger.status];
  const kind = KIND_CONFIG[trigger.kind];
  const KindIcon = kind.icon;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/60">
            <KindIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">{trigger.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.badgeClass}`}>
                {status.label}
              </span>
              <span className="rounded border border-border/50 px-1 py-0.5 text-[10px] text-muted-foreground">
                {kind.label}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Runs <span className="font-medium text-foreground">{trigger.playbookName}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="More options"
          className="flex-shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Cause detail */}
      <div className="pl-9 text-[11px] text-muted-foreground">
        {trigger.scheduleLabel && <p>{trigger.scheduleLabel}</p>}
        {trigger.eventName && <code className="font-mono">{trigger.eventName}</code>}
        {trigger.webhookUrl && (
          <code className="break-all font-mono text-[10px]">{trigger.webhookUrl}</code>
        )}
        {trigger.kind === "manual" && <p>Run manually via API or UI</p>}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 pl-9 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3" aria-hidden="true" />
          {trigger.fireCount} fires
        </span>
        {trigger.lastFiredAt && <span>Last fired {trigger.lastFiredAt}</span>}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutomationTriggersPage() {
  const activeCount = MOCK_TRIGGERS.filter((t) => t.status === "active").length;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Zap className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Triggers</p>
            <p className="text-xs text-muted-foreground">
              Cause-to-effect rules. Cause can be an event, a schedule, a webhook, or a
              manual invocation. {activeCount} of {MOCK_TRIGGERS.length} triggers active.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New trigger
        </button>
      </div>

      {/* Trigger cards */}
      <div className="flex flex-col gap-3">
        {MOCK_TRIGGERS.map((trigger) => (
          <TriggerCard key={trigger.id} trigger={trigger} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Each trigger acts as a named principal with its own capability grants.
        Webhook endpoints are workspace-scoped and authenticated by a shared secret.
      </p>
    </div>
  );
}
