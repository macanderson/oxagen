"use client";
/**
 * ForgotPasswordForm — client component for the /forgot-password page.
 *
 * After submission (success or unknown account), shows a neutral confirmation
 * message — never confirms or denies whether an account exists (anti-enumeration).
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestResetAction } from "./actions";

type Status = "idle" | "submitting" | "sent" | "error";

export function ForgotPasswordForm() {
  const [status, setStatus] = React.useState<Status>("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatus("submitting");

    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "");

    const result = await requestResetAction({ email });

    if (result.ok) {
      setStatus("sent");
    } else {
      setStatus("error");
      setErrorMsg(result.error);
    }
  };

  if (status === "sent") {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="text-sm text-foreground">
          If an account with that email exists, we&rsquo;ve sent a link to reset
          your password. Check your inbox (and spam folder).
        </p>
        <p className="text-xs text-muted-foreground">
          The link expires in 1 hour. If you don&rsquo;t receive an email within
          a few minutes, you can request another.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setStatus("idle")}
          className="self-start"
        >
          Send another link
        </Button>
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
      aria-label="Forgot password form"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          id="forgot-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
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
        {isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
