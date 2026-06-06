import { ShieldCheck } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function SecurityMfaPage({
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
              <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>MFA Policy</CardTitle>
              <CardDescription>
                Set and enforce multi-factor authentication requirements
                organization-wide — requiring TOTP, passkeys, or hardware
                security keys so that every member login satisfies the
                authentication controls required for SOC 2 and HIPAA access
                management.
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
              Org-wide MFA enforcement will be available in an upcoming release.
              Planned controls include required MFA on login, grace-period
              windows, MFA method allow-lists, and per-role exemptions.
            </p>
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
