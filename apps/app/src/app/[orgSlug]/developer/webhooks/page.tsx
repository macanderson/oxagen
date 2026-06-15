/**
 * Developer → Webhooks page.
 *
 * Webhooks are not yet implemented — no webhook_endpoints table exists in the
 * schema. This page shows an honest "coming soon" state with context on what
 * webhooks will support, rather than fabricated mock data.
 *
 * When the webhooks epic ships a migration, this page will be wired to the
 * real table. Track in Linear (OXA-webhooks, no migration this wave).
 */

import { Rss } from "lucide-react";
import { Panel } from "@/components/ui/panel";

const PLANNED_EVENTS = [
  "agent.run.completed",
  "agent.run.failed",
  "member.invited",
  "member.removed",
  "knowledge.source.synced",
  "content.generated",
  "automation.trigger.fired",
];

export default function DeveloperWebhooksPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Coming soon card */}
      <Panel title="Webhook endpoints">
        <p className="mb-4 text-sm text-muted-foreground">
          Receive real-time event payloads at your own HTTPS endpoints.
        </p>
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-border/40 bg-muted/20 px-6 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Rss className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">Webhooks coming soon</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Webhook delivery is in development. When it ships, you will be able to subscribe
                to real-time events from this page and receive HTTP POST payloads at any HTTPS
                endpoint you control.
              </p>
            </div>
          </div>
      </Panel>

      {/* Planned events preview */}
      <Panel title="Planned event types">
        <p className="mb-4 text-sm text-muted-foreground">
          These event types will be subscribable when webhooks launch.
        </p>
        <ul className="flex flex-wrap gap-2">
            {PLANNED_EVENTS.map((evt) => (
              <li
                key={evt}
                className="rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground"
              >
                {evt}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            In the meantime, all events are available as ClickHouse telemetry and via the
            Oxagen API at{" "}
            <code className="font-mono text-xs">GET /api/v1/events</code>.
          </p>
      </Panel>
    </div>
  );
}
