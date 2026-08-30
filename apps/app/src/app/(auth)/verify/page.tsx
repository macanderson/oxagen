import { OxagenLogo } from "@/components/ui/brand";

export default function VerifyPage(_props: {
  searchParams: Promise<{ email?: string }>;
}) {
  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <OxagenLogo variant="vertical" size={40} />
      </div>

      <div className="rounded-xl border bg-card p-8 shadow-md space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Verify your email
          </h1>
          <p className="text-sm text-muted-foreground">
            We sent you a verification link. Open it to finish signing in.
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          Once you&rsquo;ve verified, you&rsquo;ll be redirected to your
          workspace.
        </p>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        SOC 2 Type II · SSO/SCIM · RBAC-enforced retrieval
      </p>
    </div>
  );
}
