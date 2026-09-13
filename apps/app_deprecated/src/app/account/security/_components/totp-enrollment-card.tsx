"use client";
/**
 * TotpEnrollmentCard — TOTP (authenticator app) enrollment + management.
 *
 * Drives Better Auth's twoFactor client plugin:
 *   - enable({ password })      → returns totpURI (QR) + one-time backup codes
 *   - verifyTotp({ code })      → confirms enrollment (flips twoFactorEnabled)
 *   - disable({ password })     → turns 2FA off
 *   - generateBackupCodes(...)  → rotates backup codes (invalidates old set)
 *
 * `enabled` is resolved server-side from auth.users.two_factor_enabled and
 * passed in, so the card renders the correct state on first paint. All
 * mutations call router.refresh() so the server state re-reads.
 *
 * SECURITY: the password is held only in local component state for the single
 * request that needs it and is never logged. Secrets/backup codes are shown
 * once (Better Auth cannot re-display them) — the copy makes that explicit.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import QRCode from "react-qr-code";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@oxagen/auth/client";

/** Loose shapes for the Better Auth twoFactor client responses (types don't cross the package boundary). */
type EnableData = { totpURI?: string; backupCodes?: string[] };
type BackupData = { backupCodes?: string[] };
type ClientResult<T> = { data?: T | null; error?: { message?: string } | null };

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function BackupCodeList({ codes }: { codes: string[] }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
      <p className="mb-2 text-sm font-medium">
        Backup codes — store these somewhere safe. Each works once, and this is
        the only time they are shown.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

export default function TotpEnrollmentCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Enrollment (not-yet-enabled) flow state.
  const [password, setPassword] = React.useState("");
  const [totpUri, setTotpUri] = React.useState<string | null>(null);
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null);
  const [code, setCode] = React.useState("");

  // Management (already-enabled) flow state.
  const [managePassword, setManagePassword] = React.useState("");

  const beginEnroll = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = (await authClient.twoFactor.enable({
        password,
      })) as ClientResult<EnableData>;
      if (res.error)
        throw new Error(res.error.message ?? "Could not start setup");
      setTotpUri(res.data?.totpURI ?? null);
      setBackupCodes(res.data?.backupCodes ?? null);
      setPassword("");
    } catch (e) {
      setError(errText(e, "Could not start setup. Check your password."));
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = (await authClient.twoFactor.verifyTotp({
        code: code.trim(),
      })) as ClientResult<unknown>;
      if (res.error) throw new Error(res.error.message ?? "Invalid code");
      router.refresh();
    } catch (e) {
      setError(errText(e, "That code didn't match. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = (await authClient.twoFactor.disable({
        password: managePassword,
      })) as ClientResult<unknown>;
      if (res.error)
        throw new Error(res.error.message ?? "Could not disable 2FA");
      setManagePassword("");
      router.refresh();
    } catch (e) {
      setError(errText(e, "Could not disable 2FA. Check your password."));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = (await authClient.twoFactor.generateBackupCodes({
        password: managePassword,
      })) as ClientResult<BackupData>;
      if (res.error)
        throw new Error(res.error.message ?? "Could not regenerate codes");
      setBackupCodes(res.data?.backupCodes ?? null);
      setManagePassword("");
      setNotice(
        "New backup codes generated. Your previous codes no longer work.",
      );
    } catch (e) {
      setError(errText(e, "Could not regenerate codes. Check your password."));
    } finally {
      setBusy(false);
    }
  };

  const badge = enabled ? (
    <Badge variant="success" className="shrink-0 text-xs">
      Enrolled
    </Badge>
  ) : (
    <Badge variant="muted" className="shrink-0 text-xs">
      Not enrolled
    </Badge>
  );

  return (
    <Panel title="Multi-factor authentication" actions={badge}>
      <p className="mb-4 text-sm text-muted-foreground">
        Add a time-based one-time code from an authenticator app as a second
        step when you sign in.
      </p>

      {error ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-3 text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {enabled ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-foreground">
            Two-factor authentication is <strong>on</strong> for your account.
          </p>
          {backupCodes ? <BackupCodeList codes={backupCodes} /> : null}
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 p-4">
            <Label htmlFor="mfa-manage-password">Confirm your password</Label>
            <Input
              id="mfa-manage-password"
              type="password"
              autoComplete="current-password"
              value={managePassword}
              onChange={(e) => setManagePassword(e.target.value)}
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void regenerate()}
                disabled={busy || managePassword.length === 0}
              >
                Regenerate backup codes
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void disable()}
                disabled={busy || managePassword.length === 0}
              >
                Disable 2FA
              </Button>
            </div>
          </div>
        </div>
      ) : totpUri ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Scan this QR code with your authenticator app, then enter the
            6-digit code it shows to finish.
          </p>
          <div className="inline-block self-start rounded-lg bg-white p-4">
            <QRCode value={totpUri} size={176} />
          </div>
          {backupCodes ? <BackupCodeList codes={backupCodes} /> : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mfa-totp-code">Enter the 6-digit code</Label>
            <Input
              id="mfa-totp-code"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
            />
            <Button
              size="sm"
              onClick={() => void confirmEnroll()}
              disabled={busy || code.trim().length < 6}
              className="self-start"
            >
              Verify &amp; enable
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 p-4">
          <Label htmlFor="mfa-enroll-password">Confirm your password</Label>
          <Input
            id="mfa-enroll-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <Button
            size="sm"
            onClick={() => void beginEnroll()}
            disabled={busy || password.length === 0}
            className="self-start"
          >
            Set up authenticator app
          </Button>
        </div>
      )}
    </Panel>
  );
}
