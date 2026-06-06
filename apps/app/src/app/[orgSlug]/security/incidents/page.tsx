import { AlertTriangle } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function SecurityIncidentsPage({
  params: _params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Security Incidents</CardTitle>
              <CardDescription>
                Triage, track, and resolve security incidents with a structured
                response workflow — capturing timeline, severity, affected scope,
                containment steps, and post-incident review artifacts needed for
                SOC 2 incident-management evidence.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/20 px-5 py-4">
            <Badge variant="outline" className="shrink-0 text-xs">
              Coming soon
            </Badge>
            <p className="text-sm text-muted-foreground">
              Incident management will be available in an upcoming release.
              Planned features include severity classification, assignee
              tracking, timeline entries, linked audit events, and exportable
              post-incident reports.
            </p>
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
