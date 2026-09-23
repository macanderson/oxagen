// The Run page's side column panels (mockup `runSide`, spec pages/run.md):
// Changes, from the outputs the run recorded, and Spend by area, from the cost
// rollup. The Outputs spine sits between them and is drawn by outputs.tsx.
//
// Changes counts only what the outputs read carries: pull requests and file
// changes with a line stat. The base branch and the checks are not on the run
// record (`get_run_work`, PRs #3778 and #3779, reads them), so those rows say
// so. A read that stopped at its cap says the totals are a prefix, and a
// failed read says it failed; neither prints zero.
//
// Spend by area splits the run's money across what the tokens were spent on.
// `cost.run_totals` does not carry the per-area token columns the split needs
// (tool definitions, context frames, steering: G3), so the panel prints the
// run's cost with its basis, names the gap, and lists the tools the rollup
// counted, by calls.
import { useLocale, useTranslations } from "next-intl";
import type { RunCost, RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";

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
  const files = nodes.filter(isFileChange);
  const added = files.reduce((sum, node) => sum + (node.stat?.added ?? 0), 0);
  const removed = files.reduce(
    (sum, node) => sum + (node.stat?.removed ?? 0),
    0,
  );
  const count = (value: number) => formatCount(value, locale);
  const prefix = read.value.complete ? "" : "+";
  return (
    <Panel
      title={t("changes")}
      aside={
        pulls.length === 0 ? undefined : (
          <Badge tone="approval">
            {t(`state.${pulls[0]?.state ?? "open"}`)}
          </Badge>
        )
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("pullRequest")}</dt>
        <dd className="flex min-w-0 flex-col gap-1">
          {pulls.length === 0 ? (
            <span className="text-muted-foreground">{t("noPullRequest")}</span>
          ) : (
            pulls.map((pull) => (
              <span
                key={`${pull.seq ?? ""}${pull.name}`}
                className="flex items-center gap-2"
              >
                <span className={`${mono} truncate`}>{pull.name}</span>
                <Badge tone="approval">{t(`state.${pull.state}`)}</Badge>
              </span>
            ))
          )}
        </dd>
        <dt className="text-muted-foreground">{t("base")}</dt>
        <dd data-gap="run-work" className="text-muted-foreground">
          {t("baseNotCaptured")}
        </dd>
        <dt className="text-muted-foreground">{t("checks")}</dt>
        <dd className="text-muted-foreground">{t("noChecks")}</dd>
        <dt className="text-muted-foreground">{t("diff")}</dt>
        <dd>
          {files.length === 0 ? (
            <span className="text-muted-foreground">{t("noDiff")}</span>
          ) : (
            <span>
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
          {files.slice(0, FILE_ROWS).map((node) => (
            <li
              key={`${node.seq ?? ""}${node.name}`}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className={`${mono} min-w-0 truncate`} title={node.name}>
                {node.name}
              </span>
              <span className={`${mono} shrink-0 tabular-nums`}>
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
