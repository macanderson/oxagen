"use client";
/**
 * TwoFactorForm — client component for /two-factor.
 *
 * The sign-in second factor. Reached after a password sign-in on a 2FA-enabled
 * account, when the user holds only Better Auth's short-lived two-factor cookie
 * (no full session yet). Verifying a TOTP code — or a single-use backup code —
 * completes the sign-in and mints the session, after which we route into the
 * app. Both verifiers are rate-limited by Better Auth server-side.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@oxagen/auth/client";

type Mode = "totp" | "backup";

export function TwoFactorForm() {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>("totp");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData(e.currentTarget);
    const code = String(fd.get("code") ?? "").trim();
    try {
      const res =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({ code })
          : await authClient.twoFactor.verifyBackupCode({ code });
      if (res.error) {
        throw new Error(
          res.error.message ??
            (mode === "totp"
              ? "That code didn't match. Try again."
              : "That backup code is invalid or already used."),
        );
      }
      // Session is now established — leave the auth boundary.
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="flex flex-col gap-4"
      aria-label="Two-factor verification form"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">
          {mode === "totp" ? "Authentication code" : "Backup code"}
        </Label>
        <Input
          id="code"
          name="code"
          type="text"
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          autoFocus
          required
          placeholder={mode === "totp" ? "6-digit code" : "Backup code"}
          disabled={pending}
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="gradient"
        size="lg"
        className="w-full"
        disabled={pending}
      >
        {pending ? "Verifying…" : "Verify"}
      </Button>

      <button
        type="button"
        className="text-center text-xs text-muted-foreground hover:underline"
        onClick={() => {
          setError(null);
          setMode((m) => (m === "totp" ? "backup" : "totp"));
        }}
      >
        {mode === "totp"
          ? "Can't access your authenticator? Use a backup code"
          : "Use your authenticator app instead"}
      </button>
    </form>
  );
}
