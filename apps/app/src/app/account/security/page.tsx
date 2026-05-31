import { Lock } from "lucide-react";

export default function AccountSecurityPage() {
  return (
    <div className="flex max-w-lg flex-col items-center justify-center gap-4 rounded-2xl border border-border/60 bg-muted/30 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Lock className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Account security</p>
        <p className="text-xs text-muted-foreground">
          Password changes, MFA factors, passkeys, linked accounts, and active sessions.
          Coming soon.
        </p>
      </div>
    </div>
  );
}
