"use client";
// The steering repo setup on the repositories page (#4875). While the
// workspace's steering repo is not ready, one line under the page header says
// where setup stands, and its button opens the setup dialog: what setup does,
// then each provisioning step with the way on (./provisioning). The dialog
// opens on its own at `?setup=steering`, the address GitHub's connect returns
// to, so an owner who connected GitHub lands back in it.
//
// The component stays mounted once the repo is ready, so a dialog left open
// shows every step done and the repository's link. While the job runs, the
// page re-reads every 5 seconds.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { buttonSmall } from "@/ui/control-styles";
import { LiveRefresh } from "@/ui/live-refresh";
import { SheetDialog } from "@/ui/sheet-dialog";
import { SteeringRepoProvisioning } from "./provisioning";
import type { SteeringRepoView } from "./types";

type Pending = Exclude<SteeringRepoView["status"], "ready">;

const TONE: Record<Pending, BadgeTone> = {
  not_started: "approval",
  provisioning: "quiet",
  failed: "failed",
  blocked: "denied",
};

export function SteeringRepoSetup({
  org,
  ws,
  view,
  canAct,
  returnTo,
  initiallyOpen = false,
}: {
  org: string;
  ws: string;
  view: SteeringRepoView;
  /** An owner or admin: the setup's actions are theirs. */
  canAct: boolean;
  /** Where GitHub sends the person back to: this page with the dialog open. */
  returnTo: SafePath;
  /** The address asked for the dialog (`?setup=steering`). */
  initiallyOpen?: boolean;
}) {
  const t = useTranslations("repositories.steeringRepo.setup");
  const tStep = useTranslations("repositories.steeringRepo.provisioning.steps");
  const [open, setOpen] = useState(initiallyOpen);
  const status = view.status;
  const legacy = view.legacySource?.fullName ?? null;

  let lead: string;
  if (status === "ready") lead = "";
  else if (status === "not_started")
    lead =
      legacy === null ? t("lead.notStarted") : t("lead.legacy", { legacy });
  else if (status === "provisioning") lead = t("lead.provisioning");
  else
    lead = t(`lead.${status}`, {
      step: tStep(view.failedStep ?? "pick_connection"),
    });

  return (
    <>
      <LiveRefresh active={status === "provisioning"} />
      {status === "ready" ? null : (
        <div
          role="note"
          data-testid="steering-repo-setup-notice"
          data-status={status}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-hl px-4 py-3"
        >
          <Badge tone={TONE[status]} dot={status === "provisioning" ? "pulse" : true}>
            {t(`status.${status}`)}
          </Badge>
          <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
            {lead}
          </p>
          <button
            type="button"
            data-testid="steering-repo-setup-open"
            data-touch-target=""
            aria-haspopup="dialog"
            className={buttonSmall}
            onClick={() => {
              setOpen(true);
            }}
          >
            {canAct && status !== "provisioning" ? t("open.act") : t("open.view")}
          </button>
        </div>
      )}
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        wide
        testId="steering-repo-setup-dialog"
      >
        <div className="flex flex-col gap-4">
          <p
            data-testid="steering-repo-setup-intro"
            className="text-[13px] text-muted-foreground"
          >
            {legacy === null
              ? t("intro.create")
              : view.legacySource?.provider === "gitlab"
                ? t("intro.gitlab", { legacy })
                : t("intro.legacy", { legacy })}
          </p>
          <SteeringRepoProvisioning
            org={org}
            ws={ws}
            view={view}
            canAct={canAct}
            returnTo={returnTo}
          />
        </div>
      </SheetDialog>
    </>
  );
}
