import { ClipboardCheck } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function SecurityCompliancePage({
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
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Compliance</CardTitle>
              <CardDescription>
                Track your organization&apos;s posture against SOC 2, HIPAA,
                GDPR, and PCI DSS control frameworks — with evidence collection
                status, control mappings, and exportable compliance reports for
                audit readiness.
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
              The compliance dashboard will be available in an upcoming release.
              Planned features include control status tracking, evidence
              attachment, and one-click audit-report export for SOC 2 Type II.
            </p>
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
