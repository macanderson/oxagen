"use client";
// One memory in the drawer beside the Memories tab (the mockup's steering.js
// `DRAWERS["str-mem"]` and `memWhy`). The address carries the memory
// (`?memory=<id>`), so the server reads it with get_workspace_memory and a
// link can open the drawer. Closing it replaces the entry with the tab's own
// address and keeps the scroll.
//
// It shows the facts, the full statement, the runs that used it, its memory
// PR or its record, and the memories that say the same thing. The foot acts
// by state: Dismiss and Promote for a waiting memory, the memory PR for one
// in a PR, and Restore for a dismissed one.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type {
  WorkspaceMemory,
  WorkspaceMemoryDetail,
} from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes, type SafePath } from "@/shared/safe-path";
import { buttonPrimary, kvList, kvTerm, kvValue, linkText, mono } from "@/ui/control-styles";
import { Button } from "@/ui/button";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { PullRequestLink, SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { SteeringReadFailure } from "../read-failure";
import { useDate } from "../section";
import { dismissMemories } from "./actions";
import {
  AgentValue,
  HarnessValue,
  LastUsedValue,
  type MemoryAgents,
  MemoryStateBadge,
  memoryName,
  RepoValue,
  useMemoryWords,
} from "./cells";
import {
  type MemoryWriteFailure,
  UNANSWERED,
  useMemoryWriteFailure,
} from "./failure";

/** The runs the drawer lists before it counts the rest. */
const RUNS_SHOWN = 8;

const section = "mt-4 mb-1.5 text-sm font-semibold text-foreground";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className={kvTerm}>{term}</dt>
      <dd className={kvValue}>{children}</dd>
    </>
  );
}

/** The drawer's Uses line: the distinct runs and any uses a harness counted. */
function UsesLine({ detail }: { detail: WorkspaceMemoryDetail }) {
  const t = useTranslations("steering.memories");
  const { memory } = detail;
  if (!memory.useSignal) {
    return <span className="text-muted-foreground">{t("noSignal")}</span>;
  }
  return <>{t("drawer.usesValue", { count: memory.uses })}</>;
}

/** Why a memory with no use signal names no run. */
function NoSignalWhy({ memory }: { memory: WorkspaceMemory }) {
  const t = useTranslations("steering.memories.drawer.why");
  switch (memory.capture) {
    case "remember":
      return <>{t("remember")}</>;
    case "pull_request":
      return <>{t("pullRequest")}</>;
    case "import":
      return <>{t("import")}</>;
    case "local_gateway":
      return <>{t("other")}</>;
  }
}

function Runs({
  at,
  detail,
  readAt,
}: {
  at: { org: string; ws: string };
  detail: WorkspaceMemoryDetail;
  readAt: string;
}) {
  const t = useTranslations("steering.memories.drawer");
  const words = useMemoryWords();
  const format = useFormatter();
  const { memory, uses, usesTotal } = detail;
  if (!memory.useSignal) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="memory-why">
        <NoSignalWhy memory={memory} />
      </p>
    );
  }
  const runs = uses.flatMap((use) =>
    use.run === null ? [] : [{ ...use, run: use.run }],
  );
  const reported = uses
    .filter((use) => use.run === null && use.signal === "harness_count")
    .reduce((sum, use) => sum + use.count, 0);
  const more =
    Math.max(0, runs.length - RUNS_SHOWN) +
    Math.max(0, usesTotal - uses.length);
  return (
    <div className="flex flex-col gap-1.5" data-testid="memory-runs">
      {runs.length === 0 && reported === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noRuns")}</p>
      ) : null}
      {runs.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm">
          {runs.slice(0, RUNS_SHOWN).map((use) => (
            <li
              key={`${use.run}:${use.usedAt}`}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <SafeLink
                to={routes.run(at.org, at.ws, use.run)}
                className={`${linkText} ${mono}`}
              >
                {use.run}
              </SafeLink>
              <span className="text-muted-foreground">
                {format.relativeTime(new Date(use.usedAt), new Date(readAt))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("moreUses", { count: more })}
        </p>
      ) : null}
      {reported > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("reported", {
            harness:
              memory.harness === null
                ? words.source(memory)
                : words.harness(memory.harness),
            count: reported,
          })}
        </p>
      ) : null}
    </div>
  );
}

/** The memory PR that cites it, its record once promoted, or where it stands otherwise. */
function Standing({
  at,
  detail,
}: {
  at: { org: string; ws: string };
  detail: WorkspaceMemoryDetail;
}) {
  const t = useTranslations("steering.memories.drawer");
  const date = useDate();
  const { memory, memoryPr } = detail;
  const url = memoryPr === null ? null : parsePullRequestUrl(memoryPr.url);
  if (memory.state === "promoted") {
    return (
      <>
        <h3 className={section}>{t("record")}</h3>
        {memory.promotedLineage === null ? (
          <p className="text-sm text-muted-foreground">
            {t("promotedMerged")}
          </p>
        ) : (
          <SafeLink
            to={routes.steeringRecord(at.org, at.ws, memory.promotedLineage)}
            className={`${linkText} ${mono} text-sm`}
          >
            {memory.promotedLineage}
          </SafeLink>
        )}
      </>
    );
  }
  let body: ReactNode;
  if (memory.state === "dismissed") {
    body = t("dismissed");
  } else if (memory.state === "retired") {
    body =
      memory.retiredReason === "deleted" && memory.retiredAt !== null
        ? t("retiredDeleted", { date: date(memory.retiredAt) })
        : t("retiredUnused");
  } else if (memoryPr === null) {
    body = t("noPr");
  } else {
    const label = t("prNumber", { number: String(memoryPr.number) });
    body = (
      <span className="flex flex-wrap items-baseline gap-x-2">
        {url === null ? (
          <span>{label}</span>
        ) : (
          <PullRequestLink to={url} className={linkText}>
            {label}
          </PullRequestLink>
        )}
        <span className="text-muted-foreground">
          {t(`prStatus.${memoryPr.status}`)}
        </span>
      </span>
    );
  }
  return (
    <>
      <h3 className={section}>{t("memoryPr")}</h3>
      <div className="text-sm text-foreground" data-testid="memory-standing">
        {body}
      </div>
    </>
  );
}

function Restore({
  at,
  memoryId,
  onRestored,
}: {
  at: { org: string; ws: string };
  memoryId: string;
  onRestored: (text: string) => void;
}) {
  const t = useTranslations("steering.memories.drawer");
  const failureText = useMemoryWriteFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const restore = async () => {
    setPending(true);
    setFailure(null);
    const result: Awaited<ReturnType<typeof dismissMemories>> =
      await dismissMemories(at.org, at.ws, [memoryId], true).catch(
        (): MemoryWriteFailure => UNANSWERED,
      );
    setPending(false);
    if (result.ok) onRestored(t("restored"));
    else setFailure(failureText(result));
  };
  return (
    <>
      {failure === null ? null : (
        <FormAlert testId="memory-restore-failure">{failure}</FormAlert>
      )}
      <Button
        type="button"
        data-testid="memory-restore"
        variant="primary"
        disabled={pending}
        onClick={() => {
          void restore();
        }}
      >
        {pending ? t("restorePending") : t("restore")}
      </Button>
    </>
  );
}

export function MemoryDrawer({
  at,
  read,
  closeTo,
  row,
  agents,
  readAt,
  onPromote,
  onDismiss,
  onRestored,
}: {
  at: { org: string; ws: string };
  read: Read<WorkspaceMemoryDetail>;
  /** The Memories tab, where closing the drawer lands. */
  closeTo: SafePath;
  /** The memories that say the same thing as this one, it included, as the list grouped them. */
  row: readonly WorkspaceMemory[];
  agents: MemoryAgents;
  readAt: string;
  onPromote: (row: readonly WorkspaceMemory[]) => void;
  onDismiss: (row: readonly WorkspaceMemory[]) => void;
  onRestored: (text: string) => void;
}) {
  const t = useTranslations("steering.memories.drawer");
  const words = useMemoryWords();
  const date = useDate();
  const navigate = useNavigate();
  const close = (open: boolean) => {
    if (!open) navigate.advance(closeTo);
  };
  if (!read.ok) {
    const title = t("notFoundTitle");
    return (
      <SheetDialog
        open
        side
        title={title}
        onOpenChange={close}
        testId="memory-drawer"
      >
        {read.reason === "error" && read.status === 404 ? (
          <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        ) : (
          <SteeringReadFailure read={read} section={t("section")} />
        )}
      </SheetDialog>
    );
  }
  const detail = read.value;
  const { memory } = detail;
  const others = row.filter((member) => member.id !== memory.id);
  const prUrl =
    memory.state === "in_pr" && detail.memoryPr !== null
      ? parsePullRequestUrl(detail.memoryPr.url)
      : null;
  const group = row.length === 0 ? [memory] : row;
  let foot: ReactNode = null;
  if (memory.state === "waiting") {
    foot = (
      <>
        <Button
          type="button"
          data-testid="memory-drawer-dismiss"
          variant="outline"
          onClick={() => {
            onDismiss(group);
          }}
        >
          {t("dismiss")}
        </Button>
        <Button
          type="button"
          data-testid="memory-drawer-promote"
          variant="primary"
          onClick={() => {
            onPromote(group);
          }}
        >
          {t("promote")}
        </Button>
      </>
    );
  } else if (prUrl !== null && detail.memoryPr !== null) {
    foot = (
      <PullRequestLink to={prUrl} className={buttonPrimary}>
        {t("openPr", { number: String(detail.memoryPr.number) })}
      </PullRequestLink>
    );
  } else if (memory.state === "dismissed") {
    foot = <Restore at={at} memoryId={memory.id} onRestored={onRestored} />;
  }
  return (
    <SheetDialog
      open
      side
      title={memoryName(memory)}
      subtitle={t("subtitle")}
      onOpenChange={close}
      testId="memory-drawer"
      footer={foot}
    >
      <div className="flex flex-col">
        <dl className={kvList} data-testid="memory-facts">
          <Fact term={t("facts.state")}>
            <MemoryStateBadge state={memory.state} />
          </Fact>
          <Fact term={t("facts.uses")}>
            <UsesLine detail={detail} />
          </Fact>
          <Fact term={t("facts.lastUsed")}>
            <LastUsedValue
              at={memory.lastUsedAt}
              signal={memory.useSignal}
              readAt={readAt}
            />
          </Fact>
          <Fact term={t("facts.harness")}>
            <HarnessValue memory={memory} />
          </Fact>
          <Fact term={t("facts.agent")}>
            <AgentValue agent={memory.agent} agents={agents} />
          </Fact>
          <Fact term={t("facts.repo")}>
            <RepoValue repos={memory.repos} />
          </Fact>
          {memory.memoryType === null ? null : (
            <Fact term={t("facts.type")}>{words.type(memory.memoryType)}</Fact>
          )}
          <Fact term={t("facts.captured")}>{date(memory.createdAt)}</Fact>
          <Fact term={t("facts.source")}>
            {memory.source === null ? (
              <span className="text-muted-foreground">{t("noSource")}</span>
            ) : (
              <code className={`${mono} break-all`} data-testid="memory-source">
                {memory.source}
              </code>
            )}
          </Fact>
        </dl>
        <h3 className={section}>{t("statement")}</h3>
        <pre
          data-testid="memory-statement"
          className={`${mono} whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-foreground`}
        >
          {memory.statement}
        </pre>
        <h3 className={section}>{t("runs")}</h3>
        <Runs at={at} detail={detail} readAt={readAt} />
        <Standing at={at} detail={detail} />
        {others.length === 0 ? null : (
          <>
            <h3 className={section}>{t("sameStatement")}</h3>
            <ul className="flex flex-col gap-1 text-sm" data-testid="memory-same">
              {others.map((other) => (
                <li key={other.id} className="flex flex-col">
                  <span className="text-foreground">{memoryName(other)}</span>
                  <span className="text-muted-foreground">
                    {words.source(other)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </SheetDialog>
  );
}
