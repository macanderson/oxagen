import type { JSX } from "react";
import Link from "next/link";
import { OxagenWordmark } from "@/components/ui/brand";
import { LoginForm } from "@/components/auth/login-form";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { safeReturnTo, withReturnTo } from "@/lib/return-to";

/**
 * /signup. `returnTo` (a same-origin path) follows the new account through
 * /new-organization and back — the desktop installer's "Create an account"
 * opens this page with `/cli/authorize?…` as the destination.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<JSX.Element> {
  const params = await searchParams;
  const returnTo = safeReturnTo(params["returnTo"] ?? params["next"]);
  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <OxagenWordmark className="h-8" />
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

        {/* A social sign-up has no organization yet; the root page (or the
            CLI consent page) sends it to /new-organization and back. */}
        <OAuthButtons callbackURL={returnTo ?? "/"} />

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">Or</span>
          </div>
        </div>

        <LoginForm mode="signup" returnTo={returnTo} />

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href={withReturnTo("/login", returnTo)}
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
