"use client";
// Fleet's two header actions (fleet.md, Header): Steer, which opens "Steer the
// fleet", and Register Agent, which opens the three-step register gate at its
// first step. Neither is gold: runs are not started here, and the page's gold
// is Approve in the shell's drawer or the primary button of an open dialog.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { RunRow } from "@/data/contracts/runs";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import type { FleetAgent } from "./board";
import { SteerFleetDialog } from "./steer-fleet";

export function FleetHeaderActions({
  org,
  ws,
  workspace,
  agents,
  agentsRead,
  agentTotal,
  agentsComplete,
  runs,
  parkedRunIds,
  canCommand,
}: {
  org: string;
  ws: string;
  /** The workspace's display name, for the dialog's hint. */
  workspace: string;
  agents: FleetAgent[];
  /** False when the agents read failed, so the dialog can say why it is empty. */
  agentsRead: boolean;
  /** Identities in the workspace (`list_agents` totals); null when the read failed. */
  agentTotal: number | null;
  /** False when the roster stopped before the workspace's last agent. */
  agentsComplete: boolean;
  runs: RunRow[];
  /** Live runs with a call parked for approval. */
  parkedRunIds: string[];
  canCommand: boolean;
}) {
  const t = useTranslations("fleet.actions");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        data-testid="fleet-steer"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("steer")}
      </button>
      <SafeLink
        to={routes.register(org, ws, "name")}
        data-testid="fleet-register"
        className={buttonSecondary}
      >
        {t("register")}
      </SafeLink>
      {open ? (
        <SteerFleetDialog
          org={org}
          ws={ws}
          workspace={workspace}
          agents={agents}
          agentsRead={agentsRead}
          agentTotal={agentTotal}
          agentsComplete={agentsComplete}
          runs={runs}
          parkedRunIds={parkedRunIds}
          canCommand={canCommand}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
