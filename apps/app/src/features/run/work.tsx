// The Run page's side column panels (mockup `runSide`, spec pages/run.md):
// Changes, from the outputs the run recorded, and Spend by area, from the cost
// rollup. The Outputs spine sits between them and is drawn by outputs.tsx.
//
// Changes reads the pull requests and their checks from `get_run_work` and
// the diff from the outputs the frames recorded. The repository's default
// branch is on neither read, so Base says so. A read that stopped at its cap
// says the totals are a prefix, and a failed read says it failed; neither
// prints zero.
//
// Spend by area splits the run's money across what the tokens were spent on.
// `cost.run_totals` does not carry the per-area token columns the split needs
// (tool definitions, context frames, steering: G3), so the panel prints the
// run's cost with its basis, names the gap, and lists the tools the rollup
// counted, by calls.
import { useLocale, useTranslations } from "next-intl";
import type { RunCost, RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { buttonSecondary, linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";
import {
  checksOf,
  ForgeLink,
  pullName,
  type RunWorkPull,
  usePullState,
  workOf,
} from "./work-ci";

/** How many changed files the panel lists before it points at the spine. */
const FILE_ROWS = 8;

type Place = { org: string; ws: string; runId: string };

function isFileChange(node: RunOutputNode) {
  return (node.kind === "file" || node.kind === "change") && node.stat !== null;
}

/**
 * A tool's family: the server of an MCP tool (`mcp__github__…` and
 * `github__…` are both `github`), and the tool itself for a harness built-in
 * (`Read`, `Bash`).
 */
export function toolFamily(name: string): string {
  const parts = name.split("__").filter((part) => part.length > 0);
  if (parts.length < 2) return name;
  return parts[0] === "mcp" && parts.length > 2
    ? (parts[1] ?? name)
    : (parts[0] ?? name);
}

/** A check's conclusion, or its status while it has none. */
function checkWord(check: CheckRun) {
  return check.conclusion ?? check.status;
}

const CHECK_TONE: Record<string, BadgeTone> = {
  passing: "allowed",
  failing: "failed",
  pending: "approval",
  neutral: "quiet",
  unknown: "quiet",
};

const PULL_TONE: Record<RunWorkPull["state"], BadgeTone> = {
  open: "approval",
  merged: "allowed",
  closed: "quiet",
};

type CheckRun = NonNullable<RunWorkPull["ci"]>["runs"][number];

/**
 * The Changes panel: the pull requests the run pushed to, the base, the
 * checks, and the diff, then one row per changed file.
 *
 * `work` is `get_run_work`: the pull requests with their state and checks as
 * the forge reports them. It is null while that read is on its way, and a
 * failed or empty read leaves the panel on what the outputs spine recorded.
 * The diff and the files come from the outputs, which carry the frame that
 * wrote each line, and from the pull request's own diff when the outputs
 * recorded no file change.
 */
export function ChangesPanel({
  read,
  work = null,
  place,
}: {
  read: Read<RunOutputs>;
  work?: Read<RunWork> | null;
  place: Place;
}) {
  const t = useTranslations("run.work");
  const stateOf = usePullState();
  const locale = useLocale();
  if (!read.ok) {
    return (
      <Panel title={t("changes")}>
        <ReadFailure read={read} section={t("changes")} />
      </Panel>
    );
  }
  const evidence = workOf(work);
  const forgePulls = evidence?.pullRequests ?? [];
  const checks = checksOf(evidence);
  const { nodes } = read.value;
  const pulls = nodes.filter((node) => node.kind === "pr");
  const recorded = nodes.filter(isFileChange).map((node) => ({
    key: `${node.seq ?? ""}${node.name}`,
    name: node.name,
    added: node.stat?.added ?? 0,
    removed: node.stat?.removed ?? 0,
  }));
  const fromPull = forgePulls.flatMap((pull) =>
    (pull.diff?.files ?? []).map((file) => ({
      key: `${pull.url}/${file.path}`,
      name: file.path,
      added: file.additions,
      removed: file.deletions,
    })),
  );
  const files = recorded.length > 0 ? recorded : fromPull;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const count = (value: number) => formatCount(value, locale);
  const prefix = recorded.length > 0 && !read.value.complete ? "+" : "";
  const firstPull = forgePulls[0];
  const aside =
    checks !== null ? (
      <Badge tone={CHECK_TONE[checks.overall] ?? "quiet"}>
        {t(`checkState.${checks.overall}`)}
      </Badge>
    ) : firstPull !== undefined ? (
      <Badge tone={PULL_TONE[firstPull.state]}>{stateOf(firstPull)}</Badge>
    ) : pulls[0] === undefined ? undefined : (
      <Badge tone="approval">{t(`state.${pulls[0].state}`)}</Badge>
    );
  return (
    <Panel title={t("changes")} aside={aside}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("pullRequest")}</dt>
        <dd className="flex min-w-0 flex-col gap-1">
          {forgePulls.length > 0 ? (
            forgePulls.map((pull) => (
              <span
                key={pull.url}
                data-testid="run-changes-pr"
                className="flex flex-wrap items-center gap-2"
              >
                <ForgeLink
                  url={pull.url}
                  className={`${mono} ${linkText} truncate`}
                >
                  {pullName(pull)}
                </ForgeLink>
                <Badge tone={PULL_TONE[pull.state]}>{stateOf(pull)}</Badge>
              </span>
            ))
          ) : pulls.length === 0 ? (
            <span className="text-muted-foreground">{t("noPullRequest")}</span>
          ) : (
            pulls.map((pull) => (
              <span
                key={`${pull.seq ?? ""}${pull.name}`}
                data-testid="run-changes-pr"
                className="flex items-center gap-2"
              >
                <span className={`${mono} truncate`}>{pull.name}</span>
                <Badge tone="approval">{t(`state.${pull.state}`)}</Badge>
              </span>
            ))
          )}
        </dd>
        <dt className="text-muted-foreground">{t("base")}</dt>
        <dd data-gap="run-work-base" className="text-muted-foreground">
          {t("baseNotCaptured")}
        </dd>
        <dt className="text-muted-foreground">{t("checks")}</dt>
        <dd className="flex min-w-0 flex-col gap-1">
          {checks === null ? (
            <span className="text-muted-foreground">{t("noChecks")}</span>
          ) : (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={CHECK_TONE[checks.overall] ?? "quiet"}>
                  {t(`checkState.${checks.overall}`)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t("checkCounts", {
                    passed: checks.counts.passed,
                    failed: checks.counts.failed,
                    pending: checks.counts.pending,
                  })}
                  {checks.complete ? "" : ` · ${t("checksPartial")}`}
                </span>
              </span>
              <ul data-testid="run-checks" className="flex flex-col gap-0.5">
                {checks.runs.slice(0, FILE_ROWS).map((check, position) => (
                  <li
                    // A check name repeats across workflow runs.
                    key={`${check.name}/${String(position)}`}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <ForgeLink url={check.url} className="min-w-0 truncate">
                      {check.name}
                    </ForgeLink>
                    <span className={`${mono} shrink-0 text-muted-foreground`}>
                      {checkWord(check)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("diff")}</dt>
        <dd>
          {files.length === 0 ? (
            <span className="text-muted-foreground">{t("noDiff")}</span>
          ) : (
            <span data-testid="run-changes-diff">
              <span className={`${mono} font-semibold text-success`}>
                +{count(added)}
                {prefix}
              </span>{" "}
              <span className={`${mono} font-semibold text-error`}>
                −{count(removed)}
                {prefix}
              </span>{" "}
              <span className="text-muted-foreground">
                {t("inFiles", { count: files.length })}
              </span>
            </span>
          )}
        </dd>
      </dl>
      {files.length === 0 ? null : (
        <ul
          data-testid="run-changed-files"
          className="mt-3 flex flex-col gap-1 border-t border-border pt-3"
        >
          {files.slice(0, FILE_ROWS).map((file) => (
            <li
              key={file.key}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className={`${mono} min-w-0 truncate`} title={file.name}>
                {file.name}
              </span>
              <span className={`${mono} shrink-0 tabular-nums`}>
                <span className="text-success">+{count(file.added)}</span>{" "}
                <span className="text-error">−{count(file.removed)}</span>
              </span>
            </li>
          ))}
          {files.length > FILE_ROWS ? (
            <li className="text-xs text-muted-foreground">
              {t("more", { count: files.length - FILE_ROWS })}
            </li>
          ) : null}
        </ul>
      )}
      {files.length === 0 ? null : (
        <SafeLink
          to={routes.run(place.org, place.ws, place.runId, {
            tab: "transcript",
            zoom: "everything",
            kinds: "tools",
          })}
          className={`${buttonSecondary} mt-3`}
        >
          {t("openDiff")}
        </SafeLink>
      )}
    </Panel>
  );
}

/** The tools the rollup counted, dearest first by calls; the rollup keeps no per-tool money. */
export function DearestTools({
  byTool,
  limit,
}: {
  byTool: readonly { name: string; calls: number }[];
  limit: number;
}) {
  const t = useTranslations("run.work");
  const tools = [...byTool].sort((a, b) => b.calls - a.calls).slice(0, limit);
  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("noTools")}</p>;
  }
  return (
    <ul data-testid="run-dearest-tools" className="flex flex-col gap-1">
      {tools.map((tool) => (
        <li
          key={tool.name}
          className="flex items-center justify-between gap-3 text-xs"
        >
          <span className={`${mono} min-w-0 truncate`} title={tool.name}>
            {tool.name}
          </span>
          <span className={`${mono} shrink-0 text-muted-foreground`}>
            {t("callCount", { count: tool.calls })}{" "}
            <span data-gap="G3">· {t("toolCostNotRecorded")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SpendByArea({
  read,
  place,
  full = false,
}: {
  read: Read<RunCost>;
  place: Place;
  /** The Cost tab's panel: up to eight tools and the note on the split. */
  full?: boolean;
}) {
  const t = useTranslations("run.work");
  if (!read.ok) {
    return (
      <Panel title={t("spend")}>
        <ReadFailure read={read} section={t("spend")} />
      </Panel>
    );
  }
  const rollup = read.value.rollup;
  if (rollup === null) {
    return (
      <Panel title={t("spend")}>
        <p className="text-sm text-muted-foreground">{t("noSpend")}</p>
      </Panel>
    );
  }
  return (
    <Panel
      title={t("spend")}
      aside={
        rollup.cost === null ? undefined : (
          <span className={`${mono} text-[11px] text-muted-foreground`}>
            <Money value={rollup.cost} /> ·{" "}
            {rollup.cost.basis ?? t("basisNotRecorded")}
          </span>
        )
      }
    >
      <p
        data-testid="run-spend-unsplit"
        data-gap="G3"
        className="max-w-prose text-sm text-muted-foreground"
      >
        {t("areasNotRecorded")}
      </p>
      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
          {t("dearestTools")}
        </p>
        <DearestTools byTool={rollup.byTool} limit={full ? 8 : 3} />
        {full ? null : (
          <SafeLink
            to={routes.run(place.org, place.ws, place.runId, { tab: "cost" })}
            className={`${linkText} text-xs`}
          >
            {t("allTools", { count: rollup.byTool.length })}
          </SafeLink>
        )}
      </div>
      {full ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          {t("splitNote")}
        </p>
      ) : null}
    </Panel>
  );
}
