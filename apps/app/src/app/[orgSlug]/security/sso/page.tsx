import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

export default async function SecuritySsoPage({
  params: _params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Panel title="Single Sign-On">
        <p className="mb-4 text-sm text-muted-foreground">
          Configure SAML 2.0 or OIDC identity providers to let your organization authenticate
          through a corporate IdP — enforcing centralized access control and supporting SSO
          mandates required for SOC 2 Type II.
        </p>
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/20 px-5 py-4">
          <Badge variant="outline" className="shrink-0 text-xs">
            Coming soon
          </Badge>
          <p className="text-sm text-muted-foreground">
            SSO configuration will be available in an upcoming release. SAML and OIDC providers,
            IdP-initiated flows, and forced-SSO enforcement are planned.
          </p>
        </div>
      </Panel>
    </div>
  );
}
