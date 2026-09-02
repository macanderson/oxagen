import Link from "next/link";
import { OxagenLogo } from "@/components/ui/brand";
import { ResetPasswordForm } from "./reset-password-form";

interface ResetPasswordPageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const params = await searchParams;
  const token = params.token ?? "";

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <OxagenLogo variant="vertical" size={40} />
      </div>

      <div className="rounded-xl border bg-card p-8 shadow-xl space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Set a new password
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter your new password below
          </p>
        </div>

        <ResetPasswordForm token={token} />

        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        SOC 2 Type II · SSO/SCIM · RBAC-enforced retrieval
      </p>
    </div>
  );
}
