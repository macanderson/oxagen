"use client";
// The two writes on the Enrollment tab (#2953): revoke one host, and enroll a
// new one by minting the single-use token it presents to `enroll_host`.
//
// Both sit behind a dialog, for the same reason the identity writes do: a
// click on a row is easy to make by accident and a revoked host is not
// recoverable. Revoke names the host it is about in its title and in the
// button's accessible name, so a row of identical "Revoke" buttons stays
// distinguishable, and it takes the optional reason the contract records on
// the row and on the queued command.
//
// A refusal is named in the dialog and changes nothing. A completed revoke
// re-renders the page it is on, because the row's status, its revoked line and
// the collector's next answer all come from the read the page made.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { DesktopDownloads } from "@/ui/desktop-downloads";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  type EnrollmentToken,
  issueAgentEnrollmentToken,
  revokeHostEnrollment,
} from "./actions";

/**
 * A value shown once, with a button that copies it.
 *
 * `navigator.clipboard` is absent over plain HTTP and refused by a browser
 * whose permission is denied, so the copy is attempted and its outcome is
 * announced either way. The value stays selectable text underneath, which is
 * what the person falls back to; the button never pretends it worked.
 */
function CopyValue({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const t = useTranslations("agents.detail.enrollment.enroll");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <button
          type="button"
          className={`${buttonSecondary} h-8 px-2 text-xs`}
          onClick={() => void copy()}
        >
          {state === "copied" ? t("copied") : t("copy")}
        </button>
      </div>
      <code
        data-testid={testId}
        className={`${mono} block break-all rounded-md bg-muted px-2 py-1`}
      >
        {value}
      </code>
      <p role="status" className="text-xs text-muted-foreground">
        {state === "copied"
          ? t("copied")
          : state === "failed"
            ? t("copyFailed")
            : ""}
      </p>
    </div>
  );
}

/** The minted token, its expiry, and the command to run on the machine. */
function TokenPanel({ token }: { token: EnrollmentToken }) {
  const t = useTranslations("agents.detail.enrollment.enroll");
  const format = useFormatter();
  return (
    <div data-testid="enrollment-token" className="flex flex-col gap-3">
      <CopyValue
        label={t("token")}
        value={token.token}
        testId="enrollment-token-value"
      />
      <p className="text-xs text-muted-foreground">{t("once")}</p>
      <p className="text-xs text-muted-foreground">
        {t("expires", {
          at: format.dateTime(new Date(token.expiresAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
      <CopyValue
        label={t("command")}
        value={token.enrollCommand}
        testId="enrollment-command"
      />
    </div>
  );
}

/**
 * Enroll a host: mint the token and show it once, in the dialog.
 *
 * The dialog stays open on success, because the token is the answer and
 * closing it would throw the one copy away. Minting again replaces it: a token
 * is single-use and a second one does not retire the first, so nothing is lost
 * by asking for another.
 */
export function EnrollHost({
  org,
  ws,
  agentId,
  agentName,
}: {
  org: string;
  ws: string;
  agentId: string;
  /** Named in the dialog's title, so it is clear which agent the host joins. */
  agentName: string;
}) {
  const t = useTranslations("agents.detail.enrollment.enroll");
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [token, setToken] = useState<EnrollmentToken | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setToken(null);
    }
  }

  async function mint(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await issueAgentEnrollmentToken(org, ws, agentId);
      if (result.ok) setToken(result.value);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="enroll-host"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { name: agentName })}
        testId="enroll-host-dialog"
      >
        <form onSubmit={(e) => void mint(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <DesktopDownloads />
          {failure === null ? null : (
            <FormAlert testId="enroll-host-failure">{failure}</FormAlert>
          )}
          {token === null ? null : <TokenPanel token={token} />}
          <SubmitButton
            pending={pending}
            label={token === null ? t("confirm") : t("again")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}

/** Revoke one host enrollment, confirmed by the hostname, with an optional reason. */
export function RevokeHost({
  org,
  ws,
  hostEnrollmentId,
  hostname,
  here,
}: {
  org: string;
  ws: string;
  hostEnrollmentId: string;
  hostname: string;
  /** The agent's Enrollment tab, re-read once the host is revoked. */
  here: SafePath;
}) {
  const t = useTranslations("agents.detail.enrollment.revoke");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setFailure(null);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await revokeHostEnrollment(
        org,
        ws,
        hostEnrollmentId,
        reason,
      );
      if (result.ok) {
        setOpen(false);
        navigate.replace(here);
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const fieldId = `revoke-reason-${hostEnrollmentId}`;
  return (
    <>
      <button
        type="button"
        data-testid="revoke-host"
        aria-label={t("label", { hostname })}
        className={`${buttonSecondary} h-8 px-2 text-xs`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { hostname })}
        testId="revoke-host-dialog"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <Field
            id={fieldId}
            name="reason"
            label={t("reason")}
            hint={t("reasonHint")}
            maxLength={512}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          {failure === null ? null : (
            <FormAlert testId="revoke-host-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("confirm")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
