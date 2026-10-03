"use client";
// What a run, a work order, a work item, or an issue changed (ADR-292), read
// from Oxagen's own pull request store. Two lists:
//
// - Pull requests: each one with its state, as a forge last reported it, and
//   its stored revision: the diff from its merge base to its latest head,
//   with its line counts, or the reason no diff is kept. A pull request
//   closed without merging is listed and says it is left out of the totals.
// - Files changed: per repository, every path the counted pull requests
//   changed, with summed line counts and the pull requests that changed it.
//   Opening a path reads it once from each of those pull requests' revisions
//   and draws each one's hunks under its own name. Hunks from two pull
//   requests are never joined, because each starts from its own merge base.
//
// A count the forge did not report reads as not recorded, never as zero. The
// reads go through the caller's own actions, which this layer cannot import:
// an answer is typed structurally, as ./action-failure.ts types a refusal.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import type {
  ChangeSet as ChangeSetView,
  RevisionDiff,
} from "@/data/contracts/changes";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import type { ActionFailure } from "./action-failure";
import { Badge, type BadgeTone } from "./badge";
import { eyebrowQuiet, linkText, mono, note } from "./control-styles";
import { DiffView } from "./diff-view";
import { useFormatter } from "./formatter";
import { formatCount } from "./money-format";
import { PullRequestLink } from "./navigation";

/** What a read action answers: the value, or the refusal the kernel seam classified. */
export type Answer<T> = { ok: true; value: T } | ActionFailure;

/** Reads one revision's files, only `paths`, through the caller's action. */
export type LoadDiff = (
  revisionId: string,
  paths: string[],
) => Promise<Answer<RevisionDiff>>;

type Pull = ChangeSetView["pullRequests"][number];
type Repository = ChangeSetView["repositories"][number];
type RepositoryFile = Repository["files"][number];
type HeadingLevel = 3 | 4;

/** `artState`: a pull request's state as its pill. */
const PULL_TONE: Record<Pull["state"], BadgeTone> = {
  open: "approval",
  draft: "quiet",
  merged: "allowed",
  closed: "quiet",
};

/** The section headings' tag, one level under the panel that holds the set. */
function Heading({
  level,
  id,
  children,
}: {
  level: HeadingLevel;
  id: string;
  children: string;
}) {
  const className = `${eyebrowQuiet} mb-1.5`;
  return level === 3 ? (
    <h3 id={id} className={className}>
      {children}
    </h3>
  ) : (
    <h4 id={id} className={className}>
      {children}
    </h4>
  );
}

/** `+12 −3`, or "not recorded" when the forge did not report either count. */
function LineCounts({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  const t = useTranslations("ui.changeSet");
  const locale = useLocale();
  if (additions === null || deletions === null)
    return (
      <span className="whitespace-nowrap text-sm text-dim">
        {t("countsUnknown")}
      </span>
    );
  return (
    <span className="whitespace-nowrap font-mono text-sm">
      <b className="font-semibold text-success">
        +{formatCount(additions, locale)}
      </b>{" "}
      <b className="font-semibold text-warning">
        −{formatCount(deletions, locale)}
      </b>
    </span>
  );
}

/** `acme/platform#482`, linked to its page on the forge when the URL is one. */
function PullName({ pull }: { pull: Pull }) {
  const name = `${pull.repository}#${String(pull.number)}`;
  const target = parsePullRequestUrl(pull.url);
  return target === null ? (
    <span className={`${mono} text-sm`}>{name}</span>
  ) : (
    <PullRequestLink
      to={target}
      title={pull.title ?? undefined}
      className={`${mono} ${linkText} text-sm`}
    >
      {name}
    </PullRequestLink>
  );
}

/** The sentence a refused or failed read draws in place of what it would have shown. */
function AnswerFailure({ failure }: { failure: ActionFailure | "thrown" }) {
  const t = useTranslations("ui.changeSet.failure");
  let text: string;
  if (failure === "thrown") text = t("thrown");
  else
    switch (failure.reason) {
      case "pending_approval":
        text = t("pendingApproval", { id: failure.accessRequestId });
        break;
      case "denied":
        text = t("denied", { permission: failure.code });
        break;
      case "not_found":
        text = t("notFound");
        break;
      default:
        text = t("other", { code: failure.code });
    }
  return (
    <p data-testid="change-failure" className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}

/** What a pull request's stored revision holds, or why it holds nothing yet. */
function RevisionLine({ pull }: { pull: Pull }) {
  const t = useTranslations("ui.changeSet");
  const kept = useTranslations("ui.diffView.notKept");
  const revision = pull.revision;
  if (revision === null)
    return <p className="text-sm text-dim">{t("noRevision")}</p>;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-dim">
      <LineCounts
        additions={revision.additions}
        deletions={revision.deletions}
      />
      {revision.filesChanged === null ? null : (
        <span>{t("revisionFiles", { count: revision.filesChanged })}</span>
      )}
      {revision.diffStatus === "stored" ? (
        revision.complete ? null : <span>{t("incomplete")}</span>
      ) : (
        <span data-diff-state={revision.diffStatus}>
          {kept(revision.diffStatus)}
        </span>
      )}
    </p>
  );
}

function PullRow({ pull }: { pull: Pull }) {
  const t = useTranslations("ui.changeSet");
  const format = useFormatter();
  return (
    <li
      data-testid="change-pull"
      data-state={pull.state}
      className="flex min-w-0 flex-col gap-1 border-t border-border py-2 first:border-t-0"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <PullName pull={pull} />
        <Badge
          tone={PULL_TONE[pull.state]}
          title={t("stateSeen", {
            at: format.dateTime(new Date(pull.stateSeenAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        >
          {t(`state.${pull.state}`)}
        </Badge>
      </span>
      {pull.title === null ? null : (
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {pull.title}
        </span>
      )}
      <RevisionLine pull={pull} />
      {pull.state === "closed" ? (
        <p data-testid="change-left-out" className="text-sm text-dim">
          {t("leftOut")}
        </p>
      ) : null}
    </li>
  );
}

type Loaded = "loading" | "thrown" | Answer<RevisionDiff>;

/** One pull request's hunks for one path, under that path. */
function PullHunks({
  pull,
  path,
  loaded,
}: {
  pull: Pull | undefined;
  path: string;
  loaded: Loaded | undefined;
}) {
  const t = useTranslations("ui.changeSet");
  const quiet = (text: string) => (
    <p className="text-sm text-muted-foreground">{text}</p>
  );
  let body: ReactNode;
  if (pull === undefined) body = quiet(t("pullNotListed"));
  else if (pull.revision === null) body = quiet(t("noRevision"));
  else if (loaded === undefined || loaded === "loading")
    body = (
      <p
        role="status"
        aria-busy="true"
        className="text-sm text-muted-foreground"
      >
        {t("loadingDiff")}
      </p>
    );
  else if (loaded === "thrown") body = <AnswerFailure failure="thrown" />;
  else if (!loaded.ok) body = <AnswerFailure failure={loaded} />;
  else {
    const file = loaded.value.files.find((each) => each.path === path);
    body =
      file === undefined ? (
        quiet(t("pathMissing"))
      ) : (
        <DiffView file={file} diffStatus={loaded.value.diffStatus} />
      );
  }
  return (
    <div data-testid="change-file-pull" className="pb-2">
      {pull === undefined ? null : (
        <p className="mb-1.5">
          <PullName pull={pull} />
        </p>
      )}
      {body}
    </div>
  );
}

/**
 * One path in a repository's roll-up. Opening it the first time reads the
 * path from each pull request that changed it, one read per revision.
 */
function FileRow({
  file,
  pulls,
  loadDiff,
}: {
  file: RepositoryFile;
  pulls: ReadonlyMap<string, Pull>;
  loadDiff: LoadDiff;
}) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState<Readonly<Record<string, Loaded>>>({});
  const regionId = useId();
  const refs = file.pullRequestIds.map((id) => {
    const pull = pulls.get(id);
    return pull === undefined ? null : `#${String(pull.number)}`;
  });
  const toggle = () => {
    setOpen((was) => !was);
    if (started) return;
    setStarted(true);
    for (const id of file.pullRequestIds) {
      const revision = pulls.get(id)?.revision ?? null;
      if (revision === null) continue;
      setLoaded((was) => ({ ...was, [id]: "loading" }));
      loadDiff(revision.id, [file.path]).then(
        (answer) => {
          setLoaded((was) => ({ ...was, [id]: answer }));
        },
        () => {
          setLoaded((was) => ({ ...was, [id]: "thrown" }));
        },
      );
    }
  };
  return (
    <li
      data-testid="change-file"
      className="border-t border-border first:border-t-0"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
        className="flex w-full min-w-0 items-center gap-2.5 py-2 text-left text-sm text-foreground hover:text-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true" className="flex-none text-dim">
          {open ? "▾" : "▸"}
        </span>
        <span className="min-w-0 truncate font-mono" data-truncate={file.path}>
          {file.path}
        </span>
        <span className="ml-auto flex flex-none items-center gap-2">
          <span className="font-mono text-sm text-dim">
            {refs.filter((ref) => ref !== null).join(" ")}
          </span>
          <LineCounts additions={file.additions} deletions={file.deletions} />
        </span>
      </button>
      <div id={regionId} hidden={!open} className="pl-5">
        {started
          ? file.pullRequestIds.map((id) => (
              <PullHunks
                key={id}
                pull={pulls.get(id)}
                path={file.path}
                loaded={loaded[id]}
              />
            ))
          : null}
      </div>
    </li>
  );
}

function RepositoryFiles({
  repository,
  pulls,
  loadDiff,
}: {
  repository: Repository;
  pulls: ReadonlyMap<string, Pull>;
  loadDiff: LoadDiff;
}) {
  const t = useTranslations("ui.changeSet");
  return (
    <div data-testid="change-repository" className="flex min-w-0 flex-col">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className={`${mono} font-semibold text-foreground`}>
          {repository.repository}
        </span>
        <LineCounts
          additions={repository.additions}
          deletions={repository.deletions}
        />
        <span className="text-dim">
          {t("repositorySummary", {
            files: repository.filesChanged,
            pulls: repository.pullRequests,
          })}
        </span>
      </p>
      <ul className="mt-1">
        {repository.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            pulls={pulls}
            loadDiff={loadDiff}
          />
        ))}
      </ul>
      {repository.moreFiles ? (
        <p className={`${note} mt-1.5`}>{t("moreFiles")}</p>
      ) : null}
    </div>
  );
}

/**
 * A change set: its pull requests, then its files by repository. `headingLevel`
 * is one under the panel's own heading, so the outline stays in order.
 */
export function ChangeSet({
  changeSet,
  loadDiff,
  headingLevel = 4,
}: {
  changeSet: ChangeSetView;
  loadDiff: LoadDiff;
  headingLevel?: HeadingLevel;
}) {
  const t = useTranslations("ui.changeSet");
  const pullsId = useId();
  const filesId = useId();
  if (changeSet.pullRequests.length === 0)
    return (
      <p data-testid="change-set-empty" className="text-sm text-muted-foreground">
        {t("empty")}
      </p>
    );
  const pulls = new Map<string, Pull>(
    changeSet.pullRequests.map((pull) => [pull.id, pull]),
  );
  return (
    <div data-testid="change-set" className="flex min-w-0 flex-col gap-3.5">
      <p className="text-sm text-muted-foreground">{t("rule")}</p>
      <section aria-labelledby={pullsId} className="min-w-0">
        <Heading level={headingLevel} id={pullsId}>
          {t("pullsHeading")}
        </Heading>
        <ul>
          {changeSet.pullRequests.map((pull) => (
            <PullRow key={pull.id} pull={pull} />
          ))}
        </ul>
        {changeSet.morePullRequests ? (
          <p className={`${note} mt-1.5`}>{t("morePullRequests")}</p>
        ) : null}
      </section>
      <section aria-labelledby={filesId} className="min-w-0">
        <Heading level={headingLevel} id={filesId}>
          {t("filesHeading")}
        </Heading>
        {changeSet.repositories.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noFiles")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {changeSet.repositories.map((repository) => (
              <RepositoryFiles
                key={`${repository.provider}:${repository.repository}`}
                repository={repository}
                pulls={pulls}
                loadDiff={loadDiff}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * A change set read when a person opens it: a work order's on the work item
 * page, an issue's on the Run page's Issues tab. The first opening reads it
 * once, and later openings show what that read answered.
 */
export function ChangeSetDisclosure({
  label,
  load,
  loadDiff,
  testId,
}: {
  /** The button's words, already translated: whose changes these are. */
  label: string;
  load: () => Promise<Answer<ChangeSetView>>;
  loadDiff: LoadDiff;
  testId?: string;
}) {
  const t = useTranslations("ui.changeSet");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    "idle" | "loading" | "thrown" | Answer<ChangeSetView>
  >("idle");
  const regionId = useId();
  const toggle = () => {
    setOpen((was) => !was);
    if (state !== "idle") return;
    setState("loading");
    load().then(
      (answer) => {
        setState(answer);
      },
      () => {
        setState("thrown");
      },
    );
  };
  let body: ReactNode;
  if (state === "loading")
    body = (
      <p
        role="status"
        aria-busy="true"
        className="text-sm text-muted-foreground"
      >
        {t("loading")}
      </p>
    );
  else if (state === "thrown") body = <AnswerFailure failure="thrown" />;
  else if (state === "idle") body = null;
  else if (state.ok)
    body = <ChangeSet changeSet={state.value} loadDiff={loadDiff} />;
  else body = <AnswerFailure failure={state} />;
  return (
    <div data-testid={testId} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
        className="flex min-w-0 items-center gap-2 py-1.5 text-left text-sm font-medium text-foreground hover:text-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true" className="flex-none text-dim">
          {open ? "▾" : "▸"}
        </span>
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <div id={regionId} hidden={!open} className="pb-2 pl-5">
        {body}
      </div>
    </div>
  );
}
