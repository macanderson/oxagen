import { Webhook, Clock, CheckCircle2, XCircle, Plus, Pencil } from "lucide-react";
import { Card, CardPanel, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Static mock data — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  status: "active" | "disabled" | "failing";
  events: string[];
  lastDeliveredAt: string | null;
  successRate: number;
  createdAt: string;
}

const MOCK_WEBHOOKS: WebhookEndpoint[] = [
  {
    id: "wh_01",
    name: "Prod: Zapier relay",
    url: "https://hooks.zapier.com/hooks/catch/12345678/abcdefg/",
    status: "active",
    events: ["agent.run.completed", "agent.run.failed"],
    lastDeliveredAt: "2026-06-06T10:22:00Z",
    successRate: 98,
    createdAt: "2026-04-12T08:00:00Z",
  },
  {
    id: "wh_02",
    name: "Slack notifications",
    url: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    status: "active",
    events: ["member.invited", "member.removed", "agent.run.failed"],
    lastDeliveredAt: "2026-06-06T09:55:00Z",
    successRate: 100,
    createdAt: "2026-05-01T12:00:00Z",
  },
  {
    id: "wh_03",
    name: "Data warehouse sync",
    url: "https://ingest.example.com/oxagen/events",
    status: "failing",
    events: ["knowledge.source.synced", "agent.run.completed"],
    lastDeliveredAt: "2026-06-05T16:40:00Z",
    successRate: 34,
    createdAt: "2026-05-20T09:30:00Z",
  },
  {
    id: "wh_04",
    name: "Dev: ngrok tunnel",
    url: "https://a1b2c3d4.ngrok.io/webhook",
    status: "disabled",
    events: ["*"],
    lastDeliveredAt: null,
    successRate: 0,
    createdAt: "2026-06-01T14:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusVariant(
  status: WebhookEndpoint["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "failing") return "destructive";
  return "outline";
}

function StatusIcon({ status }: { status: WebhookEndpoint["status"] }) {
  if (status === "active") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" aria-hidden="true" />;
  }
  if (status === "failing") {
    return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" aria-hidden="true" />;
  }
  return <div className="h-3.5 w-3.5 rounded-full border border-border/60 bg-muted shrink-0" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DeveloperWebhooksPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        Preview · not yet wired to live data
      </div>

      {/* Endpoint list */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                <Webhook className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <div>
                <CardTitle>Webhook endpoints</CardTitle>
                <CardDescription>
                  Receive real-time event payloads at your own HTTPS endpoints.
                </CardDescription>
              </div>
            </div>
            <Button size="sm" variant="outline" disabled>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add endpoint
            </Button>
          </div>
        </CardHeader>

        <CardPanel>
          <div className="flex flex-col divide-y divide-border/60">
            {MOCK_WEBHOOKS.map((wh) => (
              <div
                key={wh.id}
                className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4"
              >
                {/* Status icon + name/url */}
                <div className="flex flex-1 min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={wh.status} />
                    <span className="text-sm font-medium text-foreground">{wh.name}</span>
                    <Badge variant={statusVariant(wh.status)} className="text-xs capitalize">
                      {wh.status}
                    </Badge>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground truncate max-w-xs sm:max-w-md">
                    {wh.url}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {wh.events.map((e) => (
                      <span
                        key={e}
                        className="rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Stats + actions */}
                <div className="flex shrink-0 items-center gap-4">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {formatRelative(wh.lastDeliveredAt)}
                    </span>
                    {wh.status !== "disabled" && (
                      <span className="text-xs text-muted-foreground">
                        {wh.successRate}% success
                      </span>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" disabled aria-label={`Edit ${wh.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>

      {/* Delivery log stub */}
      <Card>
        <CardHeader>
          <CardTitle>Recent deliveries</CardTitle>
          <CardDescription>
            The last 50 delivery attempts across all endpoints, newest first.
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <div className="flex flex-col divide-y divide-border/60">
            {([
              { id: "d1", endpoint: "Prod: Zapier relay", event: "agent.run.completed", status: 200, ts: "2026-06-06T10:22:00Z" },
              { id: "d2", endpoint: "Slack notifications", event: "member.invited", status: 200, ts: "2026-06-06T09:55:00Z" },
              { id: "d3", endpoint: "Data warehouse sync", event: "agent.run.completed", status: 503, ts: "2026-06-05T16:40:00Z" },
              { id: "d4", endpoint: "Slack notifications", event: "agent.run.failed", status: 200, ts: "2026-06-05T14:11:00Z" },
              { id: "d5", endpoint: "Data warehouse sync", event: "knowledge.source.synced", status: 500, ts: "2026-06-05T12:05:00Z" },
            ] as const).map((d) => (
              <div key={d.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground font-mono">{d.event}</span>
                  <span className="text-xs text-muted-foreground">→ {d.endpoint}</span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge
                    variant={d.status === 200 ? "default" : "destructive"}
                    className="font-mono text-xs"
                  >
                    {d.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatRelative(d.ts)}</span>
                </div>
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
