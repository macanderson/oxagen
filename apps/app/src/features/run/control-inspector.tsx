// The inspector for an operator's command frame (#2953; mockup `frameDetail`
// for `control.*`, `steerShowCarrier`): what the command was, how far it got,
// the mode asked for and the mode carried, who issued it, what a steer said,
// and for a steer or a message the model frame after it that carried it.
//
// A wrapped run records the command as `oxagen:command_applied`, and the
// host's acknowledgement names that frame as `applied_at_seq`, so the command
// behind the frame is the delivery report's row applied at this seq. The
// report is `list_commands`, read by the Governed actions tab only while a
// command frame is open. A frame no row names says so rather than guessing
// at the nearest command.
import { useTranslations } from "next-intl";
import type { CommandReport, DeliveryMode } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  eyebrowQuiet,
  kvList,
  kvTerm,
  kvValue,
  linkText,
  mono,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import {
  commandAt,
  DELIVERY_COPY,
  type ReportCommand,
  STATUS_TONE,
} from "./command-report";
import { DeliveryReport } from "./delivery-report";
import type { ControlCommand } from "./player-model";

function CommandFacts({
  row,
  carrier,
}: {
  row: ReportCommand;
  carrier: { seq: string; href: SafePath } | null;
}) {
  const t = useTranslations("run.report");
  const c = useTranslations("run.control");
  const modes = useTranslations("run.commands.delivery");
  const mode = (value: DeliveryMode) =>
    modes(`${DELIVERY_COPY[value]}.label`);
  const carries = row.command === "steer" || row.command === "message";
  return (
    <dl className={kvList}>
      <dt className={kvTerm}>{c("status")}</dt>
      <dd className={kvValue}>
        <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
      </dd>
      {row.requestedMode === null && row.deliveryMode === null ? null : (
        <>
          <dt className={kvTerm}>{t("requested")}</dt>
          <dd data-testid="control-requested" className={kvValue}>
            {row.requestedMode === null
              ? t("noMode")
              : mode(row.requestedMode)}
          </dd>
          <dt className={kvTerm}>{t("delivered")}</dt>
          <dd data-testid="control-delivered" className={kvValue}>
            {row.deliveryMode === null
              ? t("notResolved")
              : mode(row.deliveryMode)}
          </dd>
        </>
      )}
      <dt className={kvTerm}>{t("issuedBy")}</dt>
      <dd data-testid="control-issuer" className={kvValue}>
        {row.issuedBy === null ? (
          t("notRecorded")
        ) : row.issuedBy.name === null ? (
          <span className={mono}>{row.issuedBy.id}</span>
        ) : (
          row.issuedBy.name
        )}
      </dd>
      {row.text === null ? null : (
        <>
          <dt className={kvTerm}>{t("text")}</dt>
          <dd data-testid="control-text" className={kvValue}>
            <q>{row.text}</q>
          </dd>
        </>
      )}
      {row.reason === null ? null : (
        <>
          <dt className={kvTerm}>{t("reason")}</dt>
          <dd className={kvValue}>{row.reason}</dd>
        </>
      )}
      {carries ? (
        <>
          <dt className={kvTerm}>{c("carriedBy")}</dt>
          <dd data-testid="control-carrier" className={kvValue}>
            {carrier === null ? (
              c("noCarrier")
            ) : (
              <SafeLink to={carrier.href} className={linkText}>
                {t("frameLink", { seq: carrier.seq })}
              </SafeLink>
            )}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

export function ControlInspector({
  command,
  seq,
  read,
  carrier,
  org,
  ws,
  runId,
}: {
  command: ControlCommand;
  /** The open frame's seq. */
  seq: string;
  /** `list_commands` for the run. */
  read: Read<CommandReport>;
  /** The model frame after this one on the page, for a steer or a message; null when the page holds none. */
  carrier: { seq: string; href: SafePath } | null;
  org: string;
  ws: string;
  runId: string;
}) {
  const t = useTranslations("run.control");
  const row = read.ok ? commandAt(read.value, command, seq) : undefined;
  return (
    <section
      aria-labelledby="run-control-title"
      data-testid="control-inspector"
      data-command={command}
      className="flex flex-col gap-2.5 rounded-lg border border-border p-3"
    >
      <h4 id="run-control-title" className={`${eyebrowQuiet} m-0`}>
        {t("heading")}
      </h4>
      {!read.ok ? (
        <ReadFailure read={read} section={t("heading")} />
      ) : row === undefined ? (
        <p
          data-testid="control-unmatched"
          className="m-0 text-[12.5px] text-muted-foreground"
        >
          {t("unmatched")}
        </p>
      ) : (
        <CommandFacts row={row} carrier={carrier} />
      )}
      <div>
        <DeliveryReport
          org={org}
          ws={ws}
          query={{ runId }}
          testId="control-report"
        />
      </div>
    </section>
  );
}
