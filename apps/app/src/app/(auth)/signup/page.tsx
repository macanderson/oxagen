import Link from "next/link";
import { OxagenLogo } from "@/components/ui/brand";
import { LoginForm } from "@/components/auth/login-form";
import { OAuthButtons } from "@/components/auth/oauth-buttons";

export default function SignupPage() {
  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <OxagenLogo variant="vertical" size={40} />
      </div>

      <div className="rounded-xl border border-border/60 bg-card/80 p-8 shadow-xl space-y-6 backdrop-blur-xl">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Create an account
          </h1>
          <p className="text-sm text-muted-foreground">
            Start your Oxagen workspace today
          </p>
        </div>

        <OAuthButtons callbackURL="/" />

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">Or</span>
          </div>
        </div>

        <LoginForm mode="signup" />

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-primary hover:underline"
          >
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
