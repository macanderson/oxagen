import Link from "next/link";
import { OxagenLogo } from "@/components/ui/brand";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <OxagenLogo variant="vertical" size={40} />
      </div>

      <div className="rounded-xl border bg-card p-8 shadow-xl space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Reset your password
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter your email and we&rsquo;ll send you a link
          </p>
        </div>

        <ForgotPasswordForm />

        <p className="text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link href="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        SOC 2 Type II · SSO/SCIM · RBAC-enforced retrieval
      </p>
    </div>
  );
}
