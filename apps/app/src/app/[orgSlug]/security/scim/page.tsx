import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function SecurityScimPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-border/40 bg-muted/20 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <RefreshCw
          className="h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
      </span>
      <div className="flex flex-col items-center gap-2">
        <Badge variant="outline" className="text-xs">
          Coming soon
        </Badge>
        <p className="text-sm font-medium text-foreground">SCIM Provisioning</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          SCIM provisioning is in development. Automated user lifecycle
          management, group-to-role mapping, and IdP-driven deprovisioning are
          planned.
        </p>
      </div>
    </div>
  );
}
