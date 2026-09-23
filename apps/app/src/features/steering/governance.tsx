"use client";
// The governance chip on the Steering header and the dialog it opens
// (roadmap pages/steering.md, `govChip` and `govmode`).
//
// The chip reads the mode `.oxagen/rules/governance.toml` declares on the main
// repository now, as the Context PR gate reads it; it prints "unbound" or
// "not read" rather than a mode nobody read. A missing file reads as `team`,
// because that is what the gate does with it, and the chip's title says the
// file is missing. The chip is never gold: gold is identity, not state.
//
// The dialog's pick is local state until Open the Context PR. Confirming
// calls `set_governance_mode`, which writes that file and nothing else: a pull
// request under `team` or `regulated`, a commit under `solo`. Picking the mode
// already in force reports that nothing changed and calls nothing.
//
// The dialog says what that capability does, which is less than the design
// asks (#3859): the pull request is an ordinary one, not a Context PR, so the
// report says "pull request"; under `solo` the confirm button names the
// commit it makes; and a lowering needs no org-owner approval yet, so the
// note names the issue in place of promising one.
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { SteeringHub } from "@/data/contracts/steering";
import type { ActionResult } from "@/server/kernel";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { buttonPrimary, buttonSecondary, linkText } from "@/ui/control-styles";
import { PullRequestLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type GovernanceChanged, setGovernanceMode } from "./actions";
import { STEERING_GAPS } from "./gaps";

const MODES = ["solo", "team", "regulated"] as const;
type Mode = (typeof MODES)[number];

/** The note under a heading: the gold rule on the left, muted ink. */
const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";

type Outcome =
  | { ok: true; value: GovernanceChanged }
  | Exclude<ActionResult<GovernanceChanged>, { ok: true }>;

/** The mode in force as the gate reads it, or null when nothing was read. */
function modeInForce(
  governance: SteeringHub["governance"] | null,
): Mode | null {
  if (governance?.state !== "read") return null;
  if (governance.mode === "absent") return "team";
  return governance.mode === "invalid" ? null : governance.mode;
}

/** The TOML the pick would write (`oxGovernanceToml`). */
export function governanceToml(header: string, mode: Mode): string {
  return `${header}\nmode = "${mode}"\nseparation_of_duties = ${mode === "regulated" ? "true" : "false"}\n`;
}

export function GovernanceChip({
  org,
  ws,
  workspace,
  governance,
}: {
  org: string;
  ws: string;
  /** The workspace's display name, for the dialog title. */
  workspace: string;
  /** Null when the hub read itself failed. */
  governance: SteeringHub["governance"] | null;
}) {
  const t = useTranslations("steering.governance");
  const navigate = useNavigate();
  const now = modeInForce(governance);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Mode>(now ?? "team");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const repository =
    governance?.state === "read" ? governance.repository : t("mainRepository");
  let shown: string;
  let title: string;
  if (governance === null || governance.state === "unread") {
    shown = t("shown.unread");
    title = t("unreadTitle", {
      code: governance === null ? "hub_unread" : governance.code,
    });
  } else if (governance.state === "unbound") {
    shown = t("shown.unbound");
    title = t("unboundTitle");
  } else if (governance.mode === "invalid") {
    shown = t("shown.invalid");
    title = t("invalidTitle", { repository });
  } else if (governance.mode === "absent") {
    shown = "team";
    title = t("absentTitle", { repository });
  } else {
    shown = governance.mode;
    title = t("chipTitle");
  }

  const openDialog = () => {
    setPicked(now ?? "team");
    setOutcome(null);
    setOpen(true);
  };

  const confirm = () => {
    if (picked === now) {
      setOutcome({
        ok: true,
        value: {
          outcome: "unchanged",
          mode: picked,
          repository,
          branch: "",
          pullRequest: null,
        },
      });
      return;
    }
    startTransition(async () => {
      const result = await setGovernanceMode(org, ws, picked);
      setOutcome(result);
      if (result.ok && result.value.outcome === "applied") navigate.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        data-testid="governance-chip"
        data-mode={shown}
        title={title}
        onClick={openDialog}
        className={buttonSecondary}
      >
        {t("chip")} <span className="font-mono text-[12px]">{shown}</span>
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title", { workspace })}
        subtitle={t("subtitle", { repository })}
        closeLabel={outcome?.ok ? t("close") : t("cancel")}
        headerClose
        testId="governance-dialog"
        footer={
          outcome?.ok ? null : (
            <button
              type="button"
              data-touch-target=""
              className={buttonPrimary}
              disabled={pending}
              onClick={confirm}
            >
              {now === "solo"
                ? pending
                  ? t("commitPending")
                  : t("commit")
                : pending
                  ? t("pending")
                  : t("submit")}
            </button>
          )
        }
      >
        {outcome?.ok ? (
          <GovernanceResult value={outcome.value} />
        ) : (
          <div className="flex flex-col gap-3">
            <div
              role="radiogroup"
              aria-label={t("pick")}
              className="flex flex-col gap-2"
            >
              {MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={picked === mode}
                  data-mode={mode}
                  onClick={() => setPicked(mode)}
                  className="flex min-h-11 flex-col items-start gap-0.5 rounded-lg border border-border bg-card px-3.5 py-3 text-left text-[13px] hover:bg-hl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-checked:border-gold aria-checked:bg-hl"
                >
                  <span className="font-semibold text-foreground">
                    {mode}
                    {mode === now ? (
                      <span className="font-normal text-dim"> {t("now")}</span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">
                    {t(`modes.${mode}.summary`)} {t(`modes.${mode}.hint`)}
                  </span>
                </button>
              ))}
            </div>
            <pre
              data-testid="governance-toml"
              className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground"
            >
              {governanceToml(t("tomlHeader"), picked)}
            </pre>
            <p className={note} data-testid="governance-note">
              {t("note")}
            </p>
            <p
              className="text-[12.5px] text-muted-foreground"
              data-testid="governance-gap"
              data-not-backed=""
              data-issue={String(STEERING_GAPS.governance)}
            >
              {t("lowering", { issue: String(STEERING_GAPS.governance) })}
            </p>
            {outcome === null ? null : <GovernanceFailure failure={outcome} />}
          </div>
        )}
      </SheetDialog>
    </>
  );
}

function GovernanceResult({ value }: { value: GovernanceChanged }) {
  const t = useTranslations("steering.governance");
  const url =
    value.pullRequest === null
      ? null
      : parsePullRequestUrl(value.pullRequest.htmlUrl);
  return (
    <div role="status" className="flex flex-col gap-2 text-[13px]">
      <p>
        {value.outcome === "proposed"
          ? t("proposed", { repository: value.repository, mode: value.mode })
          : value.outcome === "applied"
            ? t("applied", {
                repository: value.repository,
                branch: value.branch,
                mode: value.mode,
              })
            : t("unchanged", { mode: value.mode })}
      </p>
      {url === null || value.pullRequest === null ? null : (
        <PullRequestLink to={url} className={linkText}>
          {t("openPr", { number: value.pullRequest.number })}
        </PullRequestLink>
      )}
    </div>
  );
}

const NO_REPOSITORY = new Set([
  "repository_not_installed",
  "github_not_connected",
  "production_branch_missing",
  "workspace_not_found",
]);

function GovernanceFailure({
  failure,
}: {
  failure: Exclude<Outcome, { ok: true }>;
}) {
  const t = useTranslations("steering.governance.failure");
  let text: string;
  switch (failure.reason) {
    case "denied":
      text = t("denied");
      break;
    case "pending_approval":
      text = t("pendingApproval", { accessRequestId: failure.accessRequestId });
      break;
    case "not_found":
    case "conflict":
      text = NO_REPOSITORY.has(failure.code)
        ? t("noRepository")
        : t("refused", { code: failure.code });
      break;
    case "invalid":
      text = t("refused", { code: failure.code });
      break;
    case "exhausted":
    case "unavailable":
      text = t("unavailable", { code: failure.code });
      break;
  }
  return (
    <p
      role="alert"
      data-reason={failure.reason}
      className="text-[13px] text-error-ink"
    >
      {text}
    </p>
  );
}
