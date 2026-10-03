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
//
// A ready repo still shows the line while an import that stopped after its
// demote step has a `.oxagen/` tree to move (`pendingMove`, #5082). The old
// repository no longer steers by then, so nothing else on the page says the
// move is unfinished.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { Button } from "@/ui/button";
import { LiveRefresh } from "@/ui/live-refresh";
import { SheetDialog } from "@/ui/sheet-dialog";
import { SteeringRepoProvisioning } from "./provisioning";
import { pendingMove, type SteeringRepoView } from "./types";

const TONE: Record<SteeringRepoView["status"], BadgeTone> = {
  not_started: "approval",
  provisioning: "quiet",
  failed: "failed",
  blocked: "denied",
  // A ready repo shows the line only for a pending move.
  ready: "approval",
};

export function SteeringRepoSetup({
  org,
  ws,
  view,
  canAct,
  canChangeConnection = canAct,
  returnTo,
  initiallyOpen = false,
}: {
  org: string;
  ws: string;
  view: SteeringRepoView;
  /** An org or workspace Owner or Admin: the setup's actions are theirs. */
  canAct: boolean;
  /** An org Owner or Admin: the organization's connection is theirs. */
  canChangeConnection?: boolean;
  /** Where GitHub sends the person back to: this page with the dialog open. */
  returnTo: SafePath;
  /** The address asked for the dialog (`?setup=steering`). */
  initiallyOpen?: boolean;
}) {
  const t = useTranslations("repositories.steeringRepo.setup");
  const tStep = useTranslations("repositories.steeringRepo.provisioning.steps");
  const [open, setOpen] = useState(initiallyOpen);
  const status = view.status;
  const moving = pendingMove(view);
  const legacy = view.legacySource?.fullName ?? moving?.fullName ?? null;
  const shown = status !== "ready" || moving !== null;

  let lead: string;
  if (status === "ready")
    lead = moving === null ? "" : t("lead.movePending", { legacy: moving.fullName });
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
      {!shown ? null : (
        <div
          role="note"
          data-testid="steering-repo-setup-notice"
          data-status={status}
          data-move={moving === null ? undefined : "pending"}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-hl px-4 py-3"
        >
          <Badge tone={TONE[status]} dot={status === "provisioning" ? "pulse" : true}>
            {status === "ready" ? t("status.movePending") : t(`status.${status}`)}
          </Badge>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {lead}
          </p>
          <Button
            type="button"
            data-testid="steering-repo-setup-open"
            data-touch-target=""
            aria-haspopup="dialog"
            variant="outline" size="sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            {!canAct || status === "provisioning"
              ? t("open.view")
              : status === "ready"
                ? t("open.finish")
                : t("open.act")}
          </Button>
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
            className="text-sm text-muted-foreground"
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
            canChangeConnection={canChangeConnection}
            returnTo={returnTo}
          />
        </div>
      </SheetDialog>
    </>
  );
}
