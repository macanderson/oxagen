"use client";
/**
 * set-password-form.tsx — Set-password section for OAuth-only users.
 *
 * Shown only when hasPassword === false. On success, calls router.refresh()
 * so the server re-derives the hasPassword state and the section disappears.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { setPasswordAction } from "./security-action";

export function SetPasswordForm() {
  const router = useRouter();
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [status, setStatus] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus("saving");
    setErrorMsg(null);

    // Client-side confirm check before hitting the server.
    if (newPassword !== confirmPassword) {
      setStatus("error");
      setErrorMsg("Passwords do not match");
      return;
    }

    const result = await setPasswordAction({ newPassword, confirmPassword });

    if (result.ok) {
      setStatus("saved");
      setNewPassword("");
      setConfirmPassword("");
      // Refresh so the server re-derives hasPassword === true and hides this form.
      router.refresh();
    } else {
      setStatus("error");
      setErrorMsg(result.error);
    }
  };

  const isSaving = status === "saving";

  return (
    <section aria-label="Set password" className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Set a password</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Add a password so you can sign in with your email address in addition
          to your connected accounts.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="flex flex-col gap-4"
        aria-label="Set password form"
        noValidate
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="set-new-password">New password</Label>
          <Input
            id="set-new-password"
            name="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            disabled={isSaving}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="set-confirm-password">Confirm password</Label>
          <Input
            id="set-confirm-password"
            name="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            placeholder="Repeat your password"
            disabled={isSaving}
          />
        </div>

        {status === "error" && errorMsg && (
          <p className="text-sm text-destructive" role="alert">
            {errorMsg}
          </p>
        )}

        {status === "saved" && (
          <p className="text-sm text-success" role="status">
            Password set. You can now sign in with your email and password.
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            disabled={isSaving || !newPassword || !confirmPassword}
          >
            {isSaving ? "Setting password…" : "Set password"}
          </Button>
        </div>
      </form>
    </section>
  );
}
