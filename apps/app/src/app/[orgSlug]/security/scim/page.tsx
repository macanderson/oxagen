import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

export default async function SecurityScimPage({
  params: _params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Panel title="SCIM provisioning">
        <p className="mb-4 text-sm text-muted-foreground">
          Automate user and group lifecycle management via SCIM 2.0 — letting your identity
          provider provision, update, and deprovision Oxagen members in real time, a key control
          for enterprise access governance and SOC 2 user-access reviews.
        </p>
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/20 px-5 py-4">
          <Badge variant="outline" className="shrink-0 text-xs">
            Coming soon
          </Badge>
          <p className="text-sm text-muted-foreground">
            SCIM provisioning will be available in an upcoming release. Planned features include
            bearer-token endpoint generation, group-to-role mapping, and automatic deprovisioning
            on IdP suspension.
          </p>
        </div>
      </Panel>
    </div>
  );
}
