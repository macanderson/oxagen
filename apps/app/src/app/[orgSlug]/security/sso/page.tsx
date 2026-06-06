import { Fingerprint } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function SecuritySsoPage({
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
              <Fingerprint className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>Single Sign-On</CardTitle>
              <CardDescription>
                Configure SAML 2.0 or OIDC identity providers to let your
                organization authenticate through a corporate IdP — enforcing
                centralized access control and supporting SSO mandates required
                for SOC 2 Type II.
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
              SSO configuration will be available in an upcoming release. SAML
              and OIDC providers, IdP-initiated flows, and forced-SSO enforcement
              are planned.
            </p>
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
