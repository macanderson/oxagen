"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@oxagen/auth/client";

export function LoginForm({ mode = "signin" }: { mode?: "signin" | "signup" }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "");
    const password = String(fd.get("password") ?? "");
    try {
      if (mode === "signup") {
        const name = String(fd.get("name") ?? "");
        const res = await authClient.signUp.email({ email, password, name });
        if (res.error) throw new Error(res.error.message);
      } else {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message);
        // When the account has 2FA enabled, Better Auth withholds the session
        // and returns twoFactorRedirect — the password step alone is not a
        // full sign-in. Route to the second-factor page instead of the app,
        // which has no session cookie yet and would bounce back to /login.
        const data = res.data as { twoFactorRedirect?: boolean } | null;
        if (data?.twoFactorRedirect) {
          router.push("/two-factor");
          return;
        }
      }
      router.push(mode === "signup" ? "/new-organization" : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {mode === "signup" ? (
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" type="text" required autoComplete="name" />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          {mode === "signin" ? (
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground hover:underline"
            >
              Forgot password?
            </Link>
          ) : null}
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {/* Ember gradient CTA — the brand's primary call-to-action treatment
          (matches the docs landing page). `.ox-grad-surface` paints the
          gold→flame→crimson fill over the button; the DS button keeps its
          hover-scale motion. Ink text, not white: the gold stop of the ember
          sweep is far too light for white 14px text (≈2.1:1 vs the required
          4.5:1), while ink holds ≥4.9:1 across every stop — the same
          ink-on-brand pairing every primary button in the DS uses. */}
      <Button
        type="submit"
        variant="gradient"
        size="lg"
        className="ox-grad-surface w-full border-0 text-primary-foreground shadow-sm"
        disabled={pending}
      >
        {pending ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}
