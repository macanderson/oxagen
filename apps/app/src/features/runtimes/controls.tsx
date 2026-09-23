"use client";
// The Runtimes pages' client islands: the dialogs the page opens and the one
// write, Unenroll.
//
// Nothing here enrolls a host or writes a hook (runtimes.md: enrollment is an
// installer, run on the host itself). Enroll a runtime is a link to the
// Register an agent flow, whose wrap step shows the command; Show the CLI path
// prints the command. Three controls the design draws have no capability behind
// them: Request access, Open an incident and Run a smoke session. Each opens a
// dialog that says what the product would do and that nothing records it yet,
// rather than a button that silently does nothing: Request access is #3820,
// Open an incident #3821, Run a smoke session #3819.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { routes } from "@/shared/safe-path";
import { unanswered } from "@/ui/action-failure";
import {
  buttonPrimary,
  buttonSecondary,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { unenrollRuntime } from "./actions";

/** `.btn.danger`: the ink and the border carry the red; the word carries the meaning. */
const buttonDanger = `${buttonSecondary} border-error/50! text-error-ink! hover:bg-error/10!`;

/** Enroll a runtime: the wrap flow, at its first step. Gold unless the screen already has its gold action. */
export function EnrollRuntime({
  org,
  ws,
  gold = true,
}: {
  org: string;
  ws: string;
  gold?: boolean;
}) {
  const t = useTranslations("runtimes.page");
  return (
    <SafeLink
      to={routes.register(org, ws, "name")}
      data-testid="runtimes-enroll"
      data-touch-target=""
      className={gold ? buttonPrimary : buttonSecondary}
    >
      {t("enroll")}
    </SafeLink>
  );
}

/** A button that opens a dialog of prose: the CLI path, or a stub that says what it would do. */
function DialogButton({
  label,
  title,
  testId,
  className = buttonSecondary,
  children,
}: {
  label: string;
  title: string;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-touch-target=""
        aria-haspopup="dialog"
        className={className}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        testId={`${testId}-dialog`}
      >
        <div className="flex flex-col gap-3 text-sm">{children}</div>
      </SheetDialog>
    </>
  );
}

/** Show the CLI path: the command a person runs on the host. */
export function CliPath() {
  const t = useTranslations("runtimes");
  return (
    <DialogButton
      label={t("empty.cli")}
      title={t("cli.title")}
      testId="runtimes-cli"
    >
      <p>{t("cli.body")}</p>
      <pre className={`${mono} rounded-md bg-muted px-3 py-2`}>
        {t("cli.command")}
      </pre>
      <p className="text-muted-foreground">{t("cli.note")}</p>
    </DialogButton>
  );
}

/** Request access: no capability records a request, so it names who grants the role and where. */
export function RequestAccess({
  org,
  permission,
}: {
  org: string;
  permission: string;
}) {
  const t = useTranslations("runtimes");
  return (
    <DialogButton
      label={t("denied.request")}
      title={t("stub.requestTitle")}
      testId="runtimes-request-access"
      className={buttonPrimary}
    >
      <p>{t("stub.requestBody", { permission })}</p>
      <SafeLink to={routes.roles(org)} className={`${linkText} self-start`}>
        {t("stub.requestLink")}
      </SafeLink>
    </DialogButton>
  );
}

/** Open an incident: no capability opens one from the console. */
export function OpenIncident({ code }: { code: string }) {
  const t = useTranslations("runtimes");
  return (
    <DialogButton
      label={t("error.incident")}
      title={t("stub.incidentTitle")}
      testId="runtimes-incident"
    >
      <p>{t("stub.incidentBody", { code })}</p>
    </DialogButton>
  );
}

/** Try again: re-renders the page's server read in place. */
export function TryAgain() {
  const t = useTranslations("runtimes.error");
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="runtimes-retry"
      data-touch-target=""
      className={buttonPrimary}
      onClick={() => {
        navigate.refresh();
      }}
    >
      {t("retry")}
    </button>
  );
}

/** Run a smoke session: no capability starts one, so the dialog says what it would do. */
export function SmokeSession({ hostname }: { hostname: string }) {
  const t = useTranslations("runtimes");
  return (
    <DialogButton
      label={t("detail.rollback.smoke")}
      title={t("stub.smokeTitle")}
      testId="runtime-smoke"
    >
      <p data-not-backed="smoke" data-gap="#3819">
        {t("stub.smokeBody", { hostname })}
      </p>
    </DialogButton>
  );
}

/** A refused or failed unenroll, as the seam classified it (§3.2). */
type UnenrollFailure = Exclude<
  Awaited<ReturnType<typeof unenrollRuntime>>,
  { ok: true }
>;

/** Unenroll: revokes this enrollment behind a confirming dialog. */
export function Unenroll({
  org,
  ws,
  runtimeId,
  hostname,
  agent,
}: {
  org: string;
  ws: string;
  runtimeId: string;
  hostname: string;
  /** The agent key the enrollment belongs to, named so the scope of the revoke is plain. */
  agent: string;
}) {
  const t = useTranslations("runtimes.unenroll");
  const label = useTranslations("runtimes.detail.rollback");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function failureText(result: UnenrollFailure): string {
    switch (result.reason) {
      case "denied":
        return t("failure.denied");
      case "not_found":
        return t("failure.notFound");
      case "conflict":
        return t("failure.refused", { code: result.code });
      case "invalid":
        return t("failure.invalid");
      case "pending_approval":
        return t("failure.pendingApproval", {
          accessRequestId: result.accessRequestId,
        });
      case "unavailable":
      case "exhausted":
        return t("failure.unavailable", { code: result.code });
    }
  }

  async function confirm() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await unenrollRuntime(org, ws, runtimeId);
      if (result.ok) {
        setOpen(false);
        navigate.refresh();
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(unanswered("action_failed")));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="runtime-unenroll"
        data-touch-target=""
        aria-haspopup="dialog"
        className={buttonDanger}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label("unenroll")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title", { hostname })}
        closeLabel={t("keep")}
        testId="runtime-unenroll-dialog"
      >
        <form
          className="flex flex-col gap-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <p>{t("body")}</p>
          <p className="text-muted-foreground">{t("scope", { agent })}</p>
          {failure === null ? null : (
            <FormAlert testId="runtime-unenroll-failure">{failure}</FormAlert>
          )}
          <button
            type="submit"
            data-testid="runtime-unenroll-confirm"
            data-touch-target=""
            aria-disabled={pending || undefined}
            className={`${buttonDanger} w-full`}
          >
            {pending ? t("pending") : t("confirm")}
          </button>
        </form>
      </SheetDialog>
    </>
  );
}
