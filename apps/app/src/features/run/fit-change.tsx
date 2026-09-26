"use client";
// The change a Model fit card argues for (the mockup's `fitchange` dialog,
// ADR-194): move the agent to the class the reading names, or set its effort
// to the level it names. Both are one key in the agent's definition file,
// `model` or `effort`, and the change is a Context pull request against that
// file, never a write from this page. The dialog shows the agent, the file,
// today's value and the proposed one before anything is written, and says
// nothing changes until somebody merges it.
//
// The effect per run is not recorded: no price book delta exists for a class
// move yet, and the page does not guess one.
//
// A viewer `commit_agent_definition` would refuse (not an organization Owner,
// Admin or Member) sees the button disabled with the reason, and so does
// every viewer when the agent was not read, since the file to edit is then
// unknown.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { definitionSeed } from "@/shared/agent-definition-seed";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { tomlSet } from "@/shared/toml-patch";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import {
  buttonSecondary,
  kvList,
  kvTerm,
  kvValue,
  mono,
  note,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { PullRequestLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type OpenedFitChange, openFitChange } from "./fit-actions";
import type { Place } from "./tab-props";

/** `.btn.sm { padding:4px 9px; font-size:12px; border-radius:7px }` */
const buttonSmall = `${buttonSecondary} min-h-7 rounded-[7px] px-[9px] py-1 text-xs`;

/** The roles `commit_agent_definition` admits (its contract's `defaultRoles.org`). */
const COMMIT_ROLES: ReadonlySet<OrgRole> = new Set([
  "owner",
  "admin",
  "member",
]);

/** The definition file's path: the one last committed, else where a definition is committed. */
export function definitionPath(
  identity: AgentDetail["identity"],
  definition: AgentDetail["definition"],
): string {
  return definition?.path ?? `.oxagen/agents/${identity.slug}.toml`;
}

/**
 * The file with the one key changed: the agent's committed definition, or
 * the seed its Configuration page opens on when none is committed yet.
 * `model` takes the class alias the reading names and `effort` the level,
 * both as TOML strings, at the file's top level (ADR-194).
 *
 * @internal Exported for its unit test.
 */
export function fitChangeSource(
  agent: AgentDetail,
  kind: "model" | "effort",
  value: string,
): string {
  const base = agent.definition?.source ?? definitionSeed(agent.identity);
  return tomlSet(base, null, kind, JSON.stringify(value));
}

export function FitChange({
  kind,
  today,
  suggest,
  agent,
  place,
  orgRole,
}: {
  kind: "model" | "effort";
  /** What the run ran on: the model id, or the effort value. */
  today: string;
  /** What the reading argues for: the class alias, or the effort level. */
  suggest: string;
  agent: Read<AgentDetail> | null;
  place: Place;
  orgRole: OrgRole;
}) {
  const t = useTranslations("run.cost.fit.change");
  const reasonId = useId();
  const label =
    kind === "model" ? t("move", { suggest }) : t("setEffort", { suggest });
  const refusal =
    agent === null || !agent.ok
      ? t("noAgent")
      : COMMIT_ROLES.has(orgRole)
        ? null
        : t("roleReason");
  if (refusal !== null || agent === null || !agent.ok) {
    return (
      <div className="flex flex-wrap items-center gap-[9px]">
        <button
          type="button"
          disabled
          title={refusal ?? undefined}
          aria-describedby={reasonId}
          data-testid={`fit-change-${kind}`}
          className={buttonSmall}
        >
          {label}
        </button>
        <span
          id={reasonId}
          data-testid={`fit-change-${kind}-refused`}
          className="min-w-0 text-[11.5px] text-muted-foreground"
        >
          {refusal}
        </span>
      </div>
    );
  }
  return (
    <FitChangeDialog
      kind={kind}
      label={label}
      today={today}
      suggest={suggest}
      agent={agent.value}
      write={(source, branch, message) =>
        openFitChange(place.org, place.ws, {
          agentId: agent.value.identity.id,
          branch,
          message,
          source,
        })
      }
      runId={place.runId}
    />
  );
}

function FitChangeDialog({
  kind,
  label,
  today,
  suggest,
  agent,
  runId,
  write,
}: {
  kind: "model" | "effort";
  label: string;
  today: string;
  suggest: string;
  agent: AgentDetail;
  runId: string;
  write: (
    source: string,
    branch: string,
    message: string,
  ) => ReturnType<typeof openFitChange>;
}) {
  const t = useTranslations("run.cost.fit.change");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedFitChange | null>(null);
  const { identity } = agent;
  const file = definitionPath(identity, agent.definition);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setOpened(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write(
        fitChangeSource(agent, kind, suggest),
        `agents/${identity.slug}-fit-${kind}`,
        t(`message.${kind}`, { agent: identity.name, suggest }).slice(0, 200),
      );
      if (result.ok) setOpened(result.value);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const pullUrl =
    opened === null ? null : parsePullRequestUrl(opened.pullRequest.url);
  return (
    <>
      <div className="flex flex-wrap items-center gap-[9px]">
        <button
          type="button"
          data-testid={`fit-change-${kind}`}
          className={buttonSmall}
          onClick={() => {
            setOpen(true);
          }}
        >
          {label}
        </button>
      </div>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={label}
        testId="fit-change-dialog"
      >
        {opened === null ? (
          <form
            id={formId}
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3.5"
          >
            <p className={note}>{t(`why.${kind}`, { run: runId })}</p>
            <dl className={kvList}>
              <dt className={kvTerm}>{t("agent")}</dt>
              <dd className={kvValue}>{identity.name}</dd>
              <dt className={kvTerm}>{t("file")}</dt>
              <dd className={`${kvValue} ${mono} text-[11.5px]`}>{file}</dd>
              <dt className={kvTerm}>{t("today")}</dt>
              <dd className={`${kvValue} ${mono}`}>{today}</dd>
              <dt className={kvTerm}>{t("proposed")}</dt>
              <dd className={`${kvValue} ${mono}`}>{suggest}</dd>
              <dt className={kvTerm}>{t("effect")}</dt>
              <dd className={`${kvValue} text-muted-foreground`}>
                {t("effectNotRecorded")}
              </dd>
            </dl>
            <p className={note}>{t("merge")}</p>
            {failure === null ? null : (
              <FormAlert testId="fit-change-failure">{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("open")}
              pendingLabel={t("pending")}
              testId="fit-change-open"
            />
          </form>
        ) : (
          <div
            role="status"
            data-testid="fit-change-opened"
            className="flex flex-col gap-3 text-sm"
          >
            <p>
              {t.rich("opened", {
                pr: () =>
                  pullUrl === null ? (
                    <span className={mono}>
                      #{opened.pullRequest.number}
                    </span>
                  ) : (
                    <PullRequestLink to={pullUrl} className="underline">
                      #{opened.pullRequest.number}
                    </PullRequestLink>
                  ),
              })}
            </p>
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                openChange(false);
                navigate.refresh();
              }}
            >
              {t("close")}
            </button>
          </div>
        )}
      </SheetDialog>
    </>
  );
}
