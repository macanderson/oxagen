// The Run page's side column panels (mockup `pRun`, spec pages/run.md):
// Changes, from the outputs the run recorded, and Spend by area, from the
// cost rollup's per-model rows (or a wrapped run's provisional figures until
// the rollup exists). The Outputs spine sits between them and is
// drawn by outputs.tsx.
//
// Changes counts only what the outputs read carries: pull requests, commits
// and file changes with a line stat. A read that stopped at its cap says the
// totals are a prefix, and a failed read says it failed; neither prints zero.
import { useLocale, useTranslations } from "next-intl";
import type { RunCost, RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { NoValue, Panel } from "./parts";

/** How many changed files the panel lists before it points at the spine. */
const FILE_ROWS = 8;

type Place = { org: string; ws: string; runId: string };

function isFileChange(node: RunOutputNode) {
  return (node.kind === "file" || node.kind === "change") && node.stat !== null;
}

export function ChangesPanel({
  read,
  place,
}: {
  read: Read<RunOutputs>;
  place: Place;
}) {
  const t = useTranslations("run.work");
  const locale = useLocale();
  if (!read.ok) {
    return (
      <Panel title={t("changes")}>
        <ReadFailure read={read} section={t("changes")} />
      </Panel>
    );
  }
  const { nodes } = read.value;
  const pulls = nodes.filter((node) => node.kind === "pr");
  const commits = nodes.filter((node) => node.kind === "commit").length;
  const files = nodes.filter(isFileChange);
  const added = files.reduce((sum, node) => sum + (node.stat?.added ?? 0), 0);
  const removed = files.reduce(
    (sum, node) => sum + (node.stat?.removed ?? 0),
    0,
  );
  const count = (value: number) => formatCount(value, locale);
  return (
    <Panel title={t("changes")}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("pullRequest")}</dt>
        <dd className="flex min-w-0 flex-wrap gap-1.5">
          {pulls.length === 0 ? (
            <span className="text-muted-foreground">{t("noPullRequest")}</span>
          ) : (
            pulls.map((pull) => (
              <span
                key={`${pull.seq ?? ""}${pull.name}`}
                className={`${mono} truncate`}
                title={pull.where ?? undefined}
              >
                {pull.name}
              </span>
            ))
          )}
        </dd>
        <dt className="text-muted-foreground">{t("commits")}</dt>
        <dd className="tabular-nums">
          {count(commits)}
          {read.value.complete ? "" : "+"}
        </dd>
        <dt className="text-muted-foreground">{t("diff")}</dt>
        <dd>
          {files.length === 0 ? (
            <span className="text-muted-foreground">{t("noDiff")}</span>
          ) : (
            t("diffStat", {
              added: count(added),
              removed: count(removed),
              files: files.length,
            })
          )}
        </dd>
      </dl>
      {files.length === 0 ? null : (
        <ul
          data-testid="run-changed-files"
          className="mt-3 flex flex-col gap-1"
        >
          {files.slice(0, FILE_ROWS).map((node) => (
            <li
              key={`${node.seq ?? ""}${node.name}`}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className={`${mono} min-w-0 truncate`} title={node.name}>
                {node.name}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="text-success">
                  +{count(node.stat?.added ?? 0)}
                </span>{" "}
                <span className="text-error">
                  −{count(node.stat?.removed ?? 0)}
                </span>
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
          className={`${linkText} mt-3 inline-block text-xs`}
        >
          {t("openDiff")}
        </SafeLink>
      )}
    </Panel>
  );
}

export function SpendByArea({ read }: { read: Read<RunCost> }) {
  const t = useTranslations("run.work");
  const locale = useLocale();
  if (!read.ok) {
    return (
      <Panel title={t("spend")}>
        <ReadFailure read={read} section={t("spend")} />
      </Panel>
    );
  }
  // The rollup is the figure of record. Before it exists, a wrapped run's
  // running figures stand in, labelled provisional.
  const figures = read.value.rollup ?? read.value.provisional ?? null;
  if (figures === null) {
    return (
      <Panel title={t("spend")}>
        <p className="text-sm text-muted-foreground">{t("noSpend")}</p>
      </Panel>
    );
  }
  const provisional = read.value.rollup === null;
  return (
    <Panel title={t("spend")}>
      {provisional ? (
        <p
          data-testid="run-spend-provisional"
          className="mb-2 text-xs text-muted-foreground"
        >
          {t("spendProvisional")}
        </p>
      ) : null}
      <ul
        data-testid="run-spend"
        className="flex flex-col divide-y divide-border text-sm"
      >
        {figures.byModel.map((row) => (
          <li
            key={`${row.provider ?? ""}/${row.model}`}
            className="flex items-baseline justify-between gap-3 py-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className={`${mono} truncate`}>{row.model}</span>
              <span className="text-xs text-muted-foreground">
                {t("callCount", { count: row.calls })}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">
              {row.cost === null ? <NoValue /> : <Money value={row.cost} />}
            </span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 flex gap-2 text-xs">
        <dt className="text-muted-foreground">{t("toolCalls")}</dt>
        <dd className="tabular-nums">
          {formatCount(figures.toolCalls, locale)}
        </dd>
      </dl>
    </Panel>
  );
}
