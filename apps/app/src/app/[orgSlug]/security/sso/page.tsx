import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function SecuritySsoPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-border/40 bg-muted/20 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <KeyRound
          className="h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
      </span>
      <div className="flex flex-col items-center gap-2">
        <Badge variant="outline" className="text-xs">
          Coming soon
        </Badge>
        <p className="text-sm font-medium text-foreground">Single Sign-On</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          SSO configuration is in development. SAML 2.0 and OIDC provider setup,
          IdP-initiated flows, and forced-SSO enforcement are planned.
        </p>
      </div>
    </div>
  );
}
