import { OxagenLogo } from "@/components/ui/brand";
import { TwoFactorForm } from "./two-factor-form";

/**
 * /two-factor — sign-in second factor step. Public route (the user has only the
 * short-lived 2FA cookie here, not a full session — see proxy.ts PUBLIC_PATHS).
 * A user who reaches this page with no pending 2FA challenge simply can't
 * verify; Better Auth rejects the attempt and they return to /login.
 */
export default function TwoFactorPage() {
  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <OxagenLogo variant="vertical" size={40} />
      </div>

      <div className="rounded-xl border border-border/60 bg-card/80 p-8 shadow-xl space-y-6 backdrop-blur-xl">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Two-factor authentication
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter the code from your authenticator app to finish signing in.
          </p>
        </div>

        <TwoFactorForm />
      </div>

      <p className="text-center text-xs text-muted-foreground">
        SOC 2 Type II · SSO/SCIM · RBAC-enforced retrieval
      </p>
    </div>
  );
}
