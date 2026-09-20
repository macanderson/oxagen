"use client";
// One row of the Enrollment table, and one clock for it.
//
// The page reads the agent once and the instant it read it travels with the
// hosts. An enrollment's state turns on that instant, and a page left open
// crosses an expiry without a reload, so the row judges its own against a
// clock that keeps running (`@/ui/expiry-clock`, the same one the API-key row
// uses).
//
// `packages/handlers/src/lib/tacho-host.ts:110-115` refuses a revoked host and
// then an expired one, and every enrollment carries an expiry, so a cell that
// read only the revocation would print a stored status over a host whose every
// request is refused. That refusal is the guarantee; this is the courtesy.
import { useLocale, useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { credentialState } from "@/shared/credential-state";
import type { SafePath } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { useExpiryClock } from "@/ui/expiry-clock";
import { formatCount } from "@/ui/money-format";
import { cell } from "@/ui/table";
import { RevokeHost } from "./enrollment-controls";
import { Instant, NotRecordedValue } from "./parts";

type Host = AgentDetail["hosts"][number];

function hooksKey(ok: boolean | null) {
  if (ok === null) return "unreported";
  return ok ? "ok" : "missing";
}

export function HostRow({
  host,
  now,
  org,
  ws,
  here,
}: {
  host: Host;
  now: number;
  org: string;
  ws: string;
  /** The Enrollment tab, re-read after a revoke. */
  here: SafePath;
}) {
  const t = useTranslations("agents.detail.enrollment");
  const locale = useLocale();
  // The server's instant until this host has an expiry to cross, the browser's
  // after that, so the status stops saying the enrollment is good the moment
  // `tacho-host.ts` would start refusing it.
  const state = credentialState(host, useExpiryClock(host.expiresAt, now));
  return (
    <tr data-testid="host-row">
      <td className={cell}>
        {host.hostname}
        <span className={`${mono} block text-xs text-muted-foreground`}>
          {host.platform}
        </span>
      </td>
      <td className={cell} data-state={state}>
        <span className={mono}>{host.status}</span>
        {state === "revoked" && host.revokedAt !== null ? (
          <span className="block text-xs text-muted-foreground">
            {t("revoked")} <Instant at={host.revokedAt} />
          </span>
        ) : null}
        {state === "expired" ? (
          <span className="block text-xs text-muted-foreground">
            {t("expired")} <Instant at={host.expiresAt} />
          </span>
        ) : null}
      </td>
      <td className={cell}>
        <span className={mono}>{host.mode}</span>
      </td>
      <td className={cell}>
        {host.collectorVersion === null ? (
          <NotRecordedValue />
        ) : (
          <span className={mono}>{host.collectorVersion}</span>
        )}
      </td>
      <td className={cell} data-hooks={hooksKey(host.hooksOk)}>
        {t(`hooks.${hooksKey(host.hooksOk)}`)}
      </td>
      <td className={cell}>
        {host.bundleVersionServed === null ? (
          <NotRecordedValue />
        ) : (
          t("bundleVersion", {
            version: formatCount(host.bundleVersionServed, locale),
          })
        )}
      </td>
      <td className={cell}>
        <span className={`${mono} break-all`}>{host.deviceKeyFingerprint}</span>
      </td>
      <td className={cell}>
        {host.lastSeenAt === null ? (
          t("never")
        ) : (
          <Instant at={host.lastSeenAt} />
        )}
      </td>
      <td className={cell}>
        {/*
          A revoked host has nothing left to revoke, so the cell is empty
          rather than carrying a control that would answer `conflict`. An
          expired one keeps it: expiry is judged from a date and revocation is
          recorded, and the accountable office asking for the record is the
          point.
        */}
        {state === "revoked" ? null : (
          <RevokeHost
            org={org}
            ws={ws}
            hostEnrollmentId={host.hostEnrollmentId}
            hostname={host.hostname}
            here={here}
          />
        )}
      </td>
    </tr>
  );
}
