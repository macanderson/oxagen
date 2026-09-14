"use client";
/**
 * ResetPasswordForm — client component for /reset-password.
 *
 * Reads the `token` from the URL search params (passed as a prop from the
 * page server component). On success redirects to /login with a confirmation
 * message. On invalid/expired token shows an error with a link back to
 * /forgot-password.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPasswordAction } from "./actions";

type Status = "idle" | "submitting" | "success" | "error" | "invalid-token";

interface ResetPasswordFormProps {
  /** One-time token from the ?token= query parameter. */
  token: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const router = useRouter();
  const [status, setStatus] = React.useState<Status>(() =>
    token ? "idle" : "invalid-token",
  );
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatus("submitting");

    const fd = new FormData(e.currentTarget);
    const newPassword = String(fd.get("newPassword") ?? "");
    const confirmPassword = String(fd.get("confirmPassword") ?? "");

    const result = await resetPasswordAction({
      token,
      newPassword,
      confirmPassword,
    });

    if (result.ok) {
      setStatus("success");
      // Small delay so the user sees the success message before redirect.
      setTimeout(() => {
        router.push("/login");
      }, 1500);
    } else {
      // Distinguish invalid/expired token from other errors — the token error
      // shows a different UI with a link back to /forgot-password.
      if (result.error.includes("invalid or has expired")) {
        setStatus("invalid-token");
      } else {
        setStatus("error");
      }
      setErrorMsg(result.error);
    }
  };

  if (status === "invalid-token") {
    return (
      <div role="alert" className="flex flex-col gap-3">
        <p className="text-sm text-destructive">
          {errorMsg ?? "This reset link is invalid or has expired."}
        </p>
        <p className="text-sm text-muted-foreground">
          Reset links are single-use and expire after 1 hour.
        </p>
        <Button
          render={<Link href="/forgot-password" />}
          size="sm"
          className="self-start"
        >
          Request a new link
        </Button>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div role="status" className="flex flex-col gap-2">
        <p className="text-sm text-foreground font-medium">Password updated.</p>
        <p className="text-sm text-muted-foreground">
          Redirecting to sign in&hellip;
        </p>
      </div>
    );
  }

  const isSubmitting = status === "submitting";

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="flex flex-col gap-4"
      aria-label="Reset password form"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          required
          minLength={8}
          maxLength={128}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          disabled={isSubmitting}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          maxLength={128}
          autoComplete="new-password"
          placeholder="Repeat your password"
          disabled={isSubmitting}
        />
      </div>

      {status === "error" && errorMsg ? (
        <p className="text-sm text-destructive" role="alert">
          {errorMsg}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="gradient"
        size="lg"
        className="w-full"
        disabled={isSubmitting}
      >
        {isSubmitting ? "Updating…" : "Set new password"}
      </Button>
    </form>
  );
}
