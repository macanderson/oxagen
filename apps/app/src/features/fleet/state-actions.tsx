"use client";
// The controls on Fleet's error and access-denied states (fleet.md, States):
// Try again, Open an incident, and Request access.
//
// Try again re-reads the page. Request access and Open an incident open the
// dialogs the design draws, and each says what it would send and why it cannot
// yet: no contract lets a person ask for a role, and none raises an incident
// (the kernel mints an access request only when a capability parks for
// approval, and `list_incidents` reads incidents the collector raised). A
// control that silently does nothing is the one thing the design forbids, so
// the send button is drawn disabled beside the sentence that explains it.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Badge } from "@/ui/badge";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

export function TryAgain() {
  const t = useTranslations("fleet.error");
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="fleet-retry"
      className={buttonPrimary}
      onClick={() => {
        navigate.refresh();
      }}
    >
      {t("retry")}
    </button>
  );
}

export function OpenIncident({
  code,
  status,
  at,
  traceId = null,
  requestId,
  ws,
}: {
  code: string;
  status: number;
  /** The instant the read failed, already formatted. */
  at: string;
  /** The trace the failed read ran under, when one was recorded (#3841). */
  traceId?: string | null;
  /** The id the kernel seam gave the failed read, when it reached the kernel. */
  requestId?: string;
  /** The workspace whose Fleet read failed. */
  ws: string;
}) {
  const t = useTranslations("fleet.incident");
  const attached = [
    `${String(status)} ${code}`,
    ws,
    at,
    ...(traceId === null ? [] : [t("traceItem", { id: traceId })]),
    ...(requestId === undefined ? [] : [t("requestItem", { id: requestId })]),
  ];
  const label = useTranslations("fleet.error");
  const [open, setOpen] = useState(false);
  const subjectId = useId();
  const severityId = useId();
  return (
    <>
      <button
        type="button"
        data-testid="fleet-incident"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label("incident")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        testId="incident-dialog"
        headerClose
        closeLabel={t("cancel")}
        footer={
          <button
            type="button"
            disabled
            aria-describedby={`${subjectId}-why`}
            className={buttonPrimary}
          >
            {t("raise")}
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          <label htmlFor={subjectId} className="text-xs font-medium">
            {t("subject")}
          </label>
          <input
            id={subjectId}
            defaultValue={`${String(status)} ${code}`}
            className={`${inputBase} max-md:min-h-11 max-md:text-base`}
          />
          <label htmlFor={severityId} className="text-xs font-medium">
            {t("severity")}
          </label>
          <select
            id={severityId}
            defaultValue="warning"
            className={`${inputBase} max-md:min-h-11 max-md:text-base`}
          >
            {(["critical", "warning", "info"] as const).map((sev) => (
              <option key={sev} value={sev}>
                {t(`severities.${sev}`)}
              </option>
            ))}
          </select>
          {/* The design attaches the records the incident is about. A failed
              read has no record id of its own, so it attaches what it has:
              the answer, the workspace, the instant, and the trace and the
              request the kernel seam recorded. */}
          <span id={`${subjectId}-attach`} className="text-xs font-medium">
            {t("attach")}
          </span>
          <ul
            aria-labelledby={`${subjectId}-attach`}
            data-testid="incident-attach"
            className="flex flex-wrap gap-1.5"
          >
            {attached.map((item) => (
              <li key={item}>
                {/* Not the mono badge: it lowercases, and the instant ends in Z. */}
                <Badge tone="quiet" dot={false}>
                  <span className="font-mono text-[11px]">{item}</span>
                </Badge>
              </li>
            ))}
          </ul>
          <p
            id={`${subjectId}-why`}
            data-testid="incident-unbacked"
            className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground"
          >
            {t("unbacked", { status: String(status), code, at })}
          </p>
        </div>
      </SheetDialog>
    </>
  );
}

export function RequestAccess({
  permission,
  ws,
}: {
  permission: string;
  ws: string;
}) {
  const t = useTranslations("fleet.requestAccess");
  const denied = useTranslations("fleet.denied");
  const [open, setOpen] = useState(false);
  const roleId = useId();
  const whyId = useId();
  return (
    <>
      <button
        type="button"
        data-testid="fleet-request-access"
        className={buttonPrimary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("title")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        testId="request-access-dialog"
        headerClose
        closeLabel={t("cancel")}
        footer={
          <button
            type="button"
            disabled
            aria-describedby={`${roleId}-why`}
            className={buttonPrimary}
          >
            {t("send")}
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          <label htmlFor={roleId} className="text-xs font-medium">
            {t("role")}
          </label>
          <input
            id={roleId}
            readOnly
            value={denied("neededValue", { permission, ws })}
            className={`${inputBase} font-mono max-md:min-h-11 max-md:text-base`}
          />
          <label htmlFor={whyId} className="text-xs font-medium">
            {t("why")}
          </label>
          <textarea
            id={whyId}
            rows={3}
            className={`${inputBase} resize-y max-md:min-h-11 max-md:text-base`}
          />
          <p className="text-xs text-muted-foreground">{t("note")}</p>
          <p
            id={`${roleId}-why`}
            data-testid="request-access-unbacked"
            className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground"
          >
            {t("unbacked", { permission, ws })}
          </p>
        </div>
      </SheetDialog>
    </>
  );
}
