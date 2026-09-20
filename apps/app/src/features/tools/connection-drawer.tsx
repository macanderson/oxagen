"use client";
// One connection's detail (#2957, lane: connections): everything
// `get_connection` records about the row the table names, read when the
// drawer opens rather than for every row up front.
//
// The stored credential is not among it. `get_connection` carries the
// connection's configuration, its poll health and the last error it recorded,
// and no path returns the credential to any surface: the broker mints a
// narrowed one per call and the grants log below the table is where those
// uses are read.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { ConnectionDetail } from "@/data/contracts/tools";
import { mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import type { ActionResult } from "@/server/kernel";
import { readConnection } from "./actions";
import { Fact, Facts, NotCarried, useDate } from "./parts";
import type { ToolsAt } from "./view";

type Loaded =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; detail: ConnectionDetail }
  /** The code as the seam reported it: a read's denial names the page's own
   * permission, not a handler reason, so the two are said apart. */
  | { state: "failed"; denied: boolean; code: string };

function Detail({ detail }: { detail: ConnectionDetail }) {
  const t = useTranslations("tools.connections.list");
  const date = useDate();
  const instant = (iso: string | null): ReactNode =>
    iso === null ? <NotCarried /> : date(iso);
  return (
    <div className="flex flex-col gap-4">
      <Facts>
        <Fact name="id" term={t("facts.id")}>
          <span className={`${mono} break-all`}>{detail.id}</span>
        </Fact>
        <Fact name="connector" term={t("facts.connector")}>
          <span className={mono}>{detail.connector}</span>
        </Fact>
        <Fact name="auth" term={t("facts.auth")}>
          <span className={mono}>{detail.authScheme}</span>
        </Fact>
        <Fact name="delivery" term={t("facts.delivery")}>
          <span className={mono}>{detail.deliveryMethod}</span>
        </Fact>
        <Fact name="status" term={t("facts.status")}>
          {t(`status.${detail.status}`)}
        </Fact>
        <Fact name="health" term={t("facts.health")}>
          {t(`health.${detail.healthStatus}`)}
        </Fact>
        <Fact name="entities" term={t("facts.entities")}>
          <span className="tabular-nums">{detail.entityCount}</span>
        </Fact>
        <Fact name="lastSync" term={t("facts.lastSync")}>
          {instant(detail.lastSyncAt)}
        </Fact>
        <Fact name="lastPoll" term={t("facts.lastPoll")}>
          {instant(detail.lastPollAt)}
        </Fact>
        <Fact name="nextPoll" term={t("facts.nextPoll")}>
          {instant(detail.nextPollAt)}
        </Fact>
        <Fact name="failures" term={t("facts.failures")}>
          <span className="tabular-nums">{detail.consecutiveFailureCount}</span>
        </Fact>
        <Fact name="lastError" term={t("facts.lastError")}>
          {instant(detail.lastErrorAt)}
        </Fact>
        <Fact name="errorMessage" term={t("facts.errorMessage")}>
          {detail.errorMessage === null ? (
            <NotCarried />
          ) : (
            <span className="break-words">{detail.errorMessage}</span>
          )}
        </Fact>
        <Fact name="created" term={t("facts.created")}>
          {date(detail.createdAt)}
        </Fact>
        <Fact name="updated" term={t("facts.updated")}>
          {date(detail.updatedAt)}
        </Fact>
      </Facts>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("credentialNote")}
      </p>
    </div>
  );
}

export function ConnectionDrawer({
  at,
  connectionId,
  title,
  children,
}: {
  at: ToolsAt;
  connectionId: string;
  /** The dialog's heading: the connection's own name, as the row shows it. */
  title: string;
  /** The row's own cell content, which is what opens the drawer. */
  children: ReactNode;
}) {
  const t = useTranslations("tools.connections.list");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: "idle" });

  async function load() {
    setLoaded({ state: "loading" });
    try {
      const result: ActionResult<ConnectionDetail> = await readConnection(
        at.org,
        at.ws,
        connectionId,
      );
      setLoaded(
        result.ok
          ? { state: "loaded", detail: result.value }
          : {
              state: "failed",
              denied: result.reason === "denied",
              // A pending access request carries no code; it carries the
              // request's id, which is what names it.
              code:
                result.reason === "pending_approval"
                  ? result.accessRequestId
                  : result.code,
            },
      );
    } catch {
      setLoaded({ state: "failed", denied: false, code: "action_failed" });
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={t("open")}
        data-testid={`connection-open-${connectionId}`}
        onClick={() => {
          setOpen(true);
          void load();
        }}
        className="min-w-0 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        subtitle={connectionId}
        testId="connection-drawer"
      >
        {loaded.state === "loaded" ? (
          <Detail detail={loaded.detail} />
        ) : loaded.state === "failed" ? (
          <FormAlert testId="connection-drawer-failure">
            {loaded.denied ? t("denied") : t("failed", { code: loaded.code })}
          </FormAlert>
        ) : (
          <p
            data-state="loading"
            aria-busy="true"
            className="text-sm text-muted-foreground"
          >
            {t("loading")}
          </p>
        )}
      </SheetDialog>
    </>
  );
}
