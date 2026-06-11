/**
 * page.tsx — Workspace → Automation → Events (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: automation.eventSources.list + automation.eventSources.create
 *                 capabilities (workspace_events table, Postgres).
 *
 * Events are saved filters over the ontology that act as observable signals.
 * They are reusable across triggers and produce auditable records.
 */
import {
  Info,
  Waves,
  Plus,
  Radio,
  Filter,
  Calendar,
  CheckCircle2,
  MoreHorizontal,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type EventStatus = "active" | "paused";

interface MockEvent {
  id: string;
  name: string;
  description: string;
  status: EventStatus;
  filterSummary: string;
  entityType: string;
  lastFiredAt: string | null;
  fireCount: number;
  triggerCount: number;
  createdAt: string;
}

const MOCK_EVENTS: MockEvent[] = [
  {
    id: "evt-01",
    name: "knowledge.source.created",
    description: "Fires when a new data source is connected to the workspace.",
    status: "active",
    filterSummary: 'entity_type = "source" AND action = "created"',
    entityType: "Source",
    lastFiredAt: "2026-06-05 14:30",
    fireCount: 7,
    triggerCount: 1,
    createdAt: "2026-05-10",
  },
  {
    id: "evt-02",
    name: "agent.run.failed",
    description: "Fires when any agent run in the workspace exits with an error status.",
    status: "active",
    filterSummary: 'entity_type = "run" AND status = "error"',
    entityType: "Run",
    lastFiredAt: "2026-06-06 12:05",
    fireCount: 3,
    triggerCount: 0,
    createdAt: "2026-05-15",
  },
  {
    id: "evt-03",
    name: "billing.credit.low",
    description: 'Fires when workspace credit balance falls below the configured threshold (default: $5).',
    status: "active",
    filterSummary: 'entity_type = "billing_balance" AND balance_usd < 5',
    entityType: "Billing",
    lastFiredAt: null,
    fireCount: 0,
    triggerCount: 0,
    createdAt: "2026-05-20",
  },
  {
    id: "evt-04",
    name: "workspace.member.joined",
    description: "Fires when a new user is granted access to this workspace.",
    status: "paused",
    filterSummary: 'entity_type = "workspace_user" AND action = "joined"',
    entityType: "Member",
    lastFiredAt: "2026-05-25 10:00",
    fireCount: 2,
    triggerCount: 0,
    createdAt: "2026-05-12",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<EventStatus, { badgeClass: string; label: string }> = {
  active: {
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Active",
  },
  paused: {
    badgeClass: "bg-muted text-muted-foreground",
    label: "Paused",
  },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function EventCard({ event }: { event: MockEvent }) {
  const status = STATUS_CONFIG[event.status];
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-mono font-semibold text-foreground">{event.name}</code>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.badgeClass}`}>
              {status.label}
            </span>
            <span className="rounded border border-border/50 px-1 py-0.5 text-[10px] text-muted-foreground">
              {event.entityType}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{event.description}</p>
        </div>
        <button
          type="button"
          aria-label="More options"
          className="flex-shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <Filter className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <code className="text-[11px] font-mono text-muted-foreground">{event.filterSummary}</code>
      </div>

      {/* Stats */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Radio className="h-3 w-3" aria-hidden="true" />
          {event.fireCount} fires
        </span>
        {event.triggerCount > 0 && (
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            Used by {event.triggerCount} trigger{event.triggerCount !== 1 ? "s" : ""}
          </span>
        )}
        {event.lastFiredAt ? (
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" aria-hidden="true" />
            Last fired {event.lastFiredAt}
          </span>
        ) : (
          <span>Never fired</span>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutomationEventSourcesPage() {
  const activeCount = MOCK_EVENTS.filter((e) => e.status === "active").length;

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
          <Waves className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Events</p>
            <p className="text-xs text-muted-foreground">
              Saved filters over the ontology that act as observable signals. Events are reusable
              across triggers and produce auditable records. {activeCount} of {MOCK_EVENTS.length} active.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New event
        </button>
      </div>

      {/* Event cards */}
      <div className="flex flex-col gap-3">
        {MOCK_EVENTS.map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Events fire in real time as ontology state changes. Each firing produces an auditable record
        visible in Activity → Audit. Wire events to triggers to automate playbook execution.
      </p>
    </div>
  );
}
