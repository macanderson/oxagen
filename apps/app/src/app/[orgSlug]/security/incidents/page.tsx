import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  User,
  MessageSquare,
  ChevronRight,
  Plus,
} from "lucide-react";
import {
  Card,
  CardPanel,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// Mock data — pure presentational, zero live DB dependency (OXA-1580)
// ---------------------------------------------------------------------------

type Severity = "critical" | "high" | "medium" | "low" | "info";
type IncidentStatus = "open" | "investigating" | "contained" | "resolved" | "closed";
type TimelineEntryType = "note" | "status_change" | "evidence";

interface TimelineEntry {
  id: string;
  type: TimelineEntryType;
  author: string;
  body: string;
  at: string;
}

interface Incident {
  id: string;
  publicId: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  assignee: string;
  affectedScope: string;
  detectedAt: string;
  resolvedAt: string | null;
  timeline: TimelineEntry[];
}

const MOCK_INCIDENTS: Incident[] = [
  {
    id: "inc_1",
    publicId: "INC-0024",
    title: "Unusual login volume from EU IP range",
    severity: "high",
    status: "investigating",
    assignee: "Mac Anderson",
    affectedScope: "Auth service · 3 accounts",
    detectedAt: "Jun 6, 2026 at 07:22 AM",
    resolvedAt: null,
    timeline: [
      {
        id: "tl_1a",
        type: "status_change",
        author: "Mac Anderson",
        body: "Status changed from open → investigating.",
        at: "Jun 6 · 07:35 AM",
      },
      {
        id: "tl_1b",
        type: "note",
        author: "Mac Anderson",
        body: "Rate-limit rule tightened on /auth/login. Monitoring continues.",
        at: "Jun 6 · 08:01 AM",
      },
      {
        id: "tl_1c",
        type: "evidence",
        author: "System",
        body: "Audit log export attached: 2026-06-06-auth-events.csv",
        at: "Jun 6 · 08:10 AM",
      },
    ],
  },
  {
    id: "inc_2",
    publicId: "INC-0023",
    title: "SCIM group sync failure — Contractors",
    severity: "medium",
    status: "contained",
    assignee: "Priya Sharma",
    affectedScope: "SCIM provisioning · Contractors group",
    detectedAt: "Jun 5, 2026 at 11:02 PM",
    resolvedAt: null,
    timeline: [
      {
        id: "tl_2a",
        type: "status_change",
        author: "System",
        body: "Incident auto-opened on SCIM sync error threshold.",
        at: "Jun 5 · 11:02 PM",
      },
      {
        id: "tl_2b",
        type: "note",
        author: "Priya Sharma",
        body: "Root cause: IdP returned malformed SCIM payload for Contractors group. Partial sync applied; 7 members unaffected.",
        at: "Jun 5 · 11:30 PM",
      },
    ],
  },
  {
    id: "inc_3",
    publicId: "INC-0021",
    title: "API key exposed in public GitHub commit",
    severity: "critical",
    status: "closed",
    assignee: "James Okafor",
    affectedScope: "Developer API keys · 1 key revoked",
    detectedAt: "May 28, 2026 at 02:14 PM",
    resolvedAt: "May 28, 2026 at 03:47 PM",
    timeline: [
      {
        id: "tl_3a",
        type: "status_change",
        author: "James Okafor",
        body: "Status changed from open → investigating.",
        at: "May 28 · 02:21 PM",
      },
      {
        id: "tl_3b",
        type: "note",
        author: "James Okafor",
        body: "Exposed key (prefix ox_live_sk_b2ca) revoked immediately. GitHub secret scanning alert confirmed.",
        at: "May 28 · 02:35 PM",
      },
      {
        id: "tl_3c",
        type: "status_change",
        author: "James Okafor",
        body: "Status changed from investigating → contained.",
        at: "May 28 · 02:40 PM",
      },
      {
        id: "tl_3d",
        type: "note",
        author: "James Okafor",
        body: "Downstream scan confirmed no unauthorized API calls on the exposed key. Issuing postmortem.",
        at: "May 28 · 03:10 PM",
      },
      {
        id: "tl_3e",
        type: "status_change",
        author: "James Okafor",
        body: "Status changed from contained → resolved → closed. No data exfiltration confirmed.",
        at: "May 28 · 03:47 PM",
      },
    ],
  },
  {
    id: "inc_4",
    publicId: "INC-0019",
    title: "Brute-force lockout triggered for 2 accounts",
    severity: "low",
    status: "closed",
    assignee: "Nina Reyes",
    affectedScope: "Auth service · 2 accounts",
    detectedAt: "May 20, 2026 at 09:03 AM",
    resolvedAt: "May 20, 2026 at 09:47 AM",
    timeline: [
      {
        id: "tl_4a",
        type: "note",
        author: "Nina Reyes",
        body: "Both accounts self-unlocked after rate-limit window expired. No evidence of compromise.",
        at: "May 20 · 09:47 AM",
      },
      {
        id: "tl_4b",
        type: "status_change",
        author: "Nina Reyes",
        body: "Closed — no action required.",
        at: "May 20 · 09:47 AM",
      },
    ],
  },
];

const SEVERITY_VARIANT: Record<Severity, "error" | "warning" | "info" | "muted"> = {
  critical: "error",
  high: "warning",
  medium: "warning",
  low: "muted",
  info: "info",
};

const STATUS_VARIANT: Record<
  IncidentStatus,
  "error" | "warning" | "success" | "muted" | "info"
> = {
  open: "error",
  investigating: "warning",
  contained: "warning",
  resolved: "success",
  closed: "muted",
};

const STATUS_LABEL: Record<IncidentStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  contained: "Contained",
  resolved: "Resolved",
  closed: "Closed",
};

function TimelineIcon({ type }: { type: TimelineEntryType }) {
  const cls = "h-3 w-3 text-muted-foreground";
  if (type === "note") return <MessageSquare className={cls} aria-hidden="true" />;
  if (type === "evidence") return <CheckCircle2 className={cls} aria-hidden="true" />;
  return <ChevronRight className={cls} aria-hidden="true" />;
}

const openCount = MOCK_INCIDENTS.filter(
  (i) => i.status === "open" || i.status === "investigating",
).length;
const closedCount = MOCK_INCIDENTS.filter(
  (i) => i.status === "closed" || i.status === "resolved",
).length;
const criticalCount = MOCK_INCIDENTS.filter((i) => i.severity === "critical").length;
const activeStatuses: IncidentStatus[] = ["open", "investigating", "contained"];

export default function SecurityIncidentsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill — per scope requirement */}
      <div>
        <Badge variant="muted" className="text-[10px] tracking-wide uppercase">
          Preview · not yet wired to live data
        </Badge>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Open / Investigating</p>
          <p
            className={`text-xl font-semibold tabular-nums ${openCount > 0 ? "text-[hsl(38_92%_50%)]" : "text-foreground"}`}
          >
            {openCount}
          </p>
        </div>
        <div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Critical severity</p>
          <p
            className={`text-xl font-semibold tabular-nums ${criticalCount > 0 ? "text-destructive" : "text-foreground"}`}
          >
            {criticalCount}
          </p>
        </div>
        <div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Closed this month</p>
          <p className="text-xl font-semibold tabular-nums text-foreground">{closedCount}</p>
        </div>
      </div>

      {/* Incident list */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <div>
                <CardTitle>Security Incidents</CardTitle>
                <CardDescription>
                  Triage, track, and resolve security incidents with a structured response
                  workflow.
                </CardDescription>
              </div>
            </div>
            <Button size="sm">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New incident
            </Button>
          </div>
        </CardHeader>
        <CardPanel>
          <div className="flex flex-col gap-4">
            {MOCK_INCIDENTS.map((inc) => (
              <div
                key={inc.id}
                className="flex flex-col gap-0 rounded-xl border border-border/60 overflow-hidden"
              >
                {/* Incident header row */}
                <div className="flex flex-col gap-2 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {inc.publicId}
                      </span>
                      <p className="text-sm font-semibold text-foreground">{inc.title}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                        Detected {inc.detectedAt}
                      </span>
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {inc.assignee}
                      </span>
                      <span>{inc.affectedScope}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge
                      variant={SEVERITY_VARIANT[inc.severity]}
                      className="text-xs capitalize"
                    >
                      {inc.severity}
                    </Badge>
                    <Badge variant={STATUS_VARIANT[inc.status]} className="text-xs">
                      {STATUS_LABEL[inc.status]}
                    </Badge>
                    {inc.resolvedAt && (
                      <span className="text-xs text-muted-foreground">
                        Resolved {inc.resolvedAt}
                      </span>
                    )}
                  </div>
                </div>

                {/* Timeline */}
                <div className="px-4 py-3 bg-background">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                    Timeline
                  </p>
                  <div className="flex flex-col gap-2">
                    {inc.timeline.map((entry) => (
                      <div key={entry.id} className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted border border-border/40">
                          <TimelineIcon type={entry.type} />
                        </span>
                        <div className="flex flex-col gap-0 min-w-0">
                          <p className="text-xs text-foreground leading-snug">{entry.body}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {entry.author} · {entry.at}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Actions bar for active incidents */}
                {activeStatuses.includes(inc.status) && (
                  <>
                    <Separator />
                    <div className="flex items-center gap-2 bg-background px-4 py-2.5">
                      <Button variant="outline" size="sm">
                        Add note
                      </Button>
                      <Button variant="outline" size="sm">
                        Update status
                      </Button>
                      <Button variant="outline" size="sm">
                        Attach evidence
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
