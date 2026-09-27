// Linked work, under the Issues tab (mockup `linkedWork`, pages/run.md,
// Issues tab): the repositories the run worked in, the pull requests and
// artifacts it produced or matched, and the files it changed, each row with
// an edge chip that says how Oxagen knows it.
//
// Two reads back it, the same two the header's checkout strip and the side
// column's Changes panel read, so the three cannot name a different pull
// request: `get_run_work` (checkouts, pull requests with their checks and
// diffs, captured diffs) and `get_run_outputs` (what the frames recorded the
// run producing, each with the frame that recorded it).
//
// An edge is a claim about provenance, so it is only ever one the record
// carries: `observed` where a frame recorded the thing, `stated` where the
// run's task reference carries it, and the work read's own association word
// where a pull request only matches a commit or a branch the run recorded.
// Nothing here is inferred, and the legend counts that too.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, use } from "react";
import type { RunOutputNode, RunOutputs } from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { Read } from "@/data/read";
import { parseGitHubUrl } from "@/shared/github-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import { eyebrowQuiet, mono, note } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { GitHubLink, SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { type FrameAt, frameHref, frameKey } from "./frame-link";
import { Panel, PanelBody } from "./parts";
import type { Place } from "./tab-props";
import { isFileChange } from "./work";

type Pull = RunWork["pullRequests"][number];
type Checkout = RunWork["checkouts"][number];
type Repository = NonNullable<Checkout["repository"]>;
type CiOverall = NonNullable<Pull["ci"]>["overall"];

/**
 * How Oxagen knows a row. `observed`, `stated` and `inferred` are the
 * design's three; `commit` and `branch` are the work read's association words
 * for a pull request that only matches what the run recorded.
 */
type Edge = "observed" | "stated" | "inferred" | "commit" | "branch";

/**
 * `.edge { font-family:var(--mono); font-size:10px; padding:0 6px;
 * border-radius:5px; border:1px solid var(--border); color:var(--muted);
 * line-height:1.7 }`: the provenance chip, and the `fr N` chip beside it.
 */
const edgeChip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 font-mono text-[10px] leading-[1.7]";

/**
 * `.edge.observed { color:var(--st-proven) }`, `.edge.stated { color:
 * var(--st-approval) }`, `.edge.inferred { color:var(--k-rule) }`, each with
 * its hue at 40% on the border. A match takes the plain `.edge`.
 */
const EDGE_HUE: Record<Edge, string> = {
  observed: "border-proven/40 text-proven",
  stated: "border-info/40 text-info",
  inferred: "border-kind-rule/40 text-kind-rule",
  commit: "border-border text-muted-foreground",
  branch: "border-border text-muted-foreground",
};

/** `.dstat .a { color:var(--st-allowed) }` and `.dstat .d { color:var(--st-denied) }`. */
const ADDED = "font-semibold text-success";
const REMOVED = "font-semibold text-warning";

const PR_TONE: Record<Pull["state"], BadgeTone> = {
  open: "approval",
  merged: "allowed",
  closed: "quiet",
};

const CI_TONE: Record<CiOverall, BadgeTone> = {
  passing: "allowed",
  failing: "failed",
  pending: "approval",
  neutral: "quiet",
  unknown: "quiet",
};

/** The spine's word for what became of an output, and its hue (outputs.tsx `TONE`). */
const OUTPUT_TONE: Record<RunOutputNode["state"], BadgeTone> = {
  created: "allowed",
  written: "allowed",
  pushed: "allowed",
  open: "allowed",
  deleted: "quiet",
  renamed: "quiet",
  read: "quiet",
  withheld: "quiet",
  awaiting: "approval",
  blocked: "denied",
};

/** A check that ended without passing. */
const FAILED_CHECK: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

/** The output kinds that are artifacts on the forge, not file writes, reads or gates. */
const ARTIFACT_KINDS: ReadonlySet<RunOutputNode["kind"]> = new Set([
  "pr",
  "commit",
  "change",
  "media",
]);

/** The mockup's glyph per row (`artIc`, and `⌂` for a repository). */
const REPOSITORY_GLYPH = "⌂";
const ARTIFACT_GLYPH: Partial<Record<RunOutputNode["kind"], string>> = {
  pr: "⇄",
  commit: "⊙",
  change: "⑂",
  media: "▣",
};

/**
 * `fr 41`: the frame that recorded the row, which opens the frame player on
 * it, on the subagent's chain when a subagent recorded it (#3823).
 */
function FrameChip({ frame, place }: { frame: FrameAt; place: Place }) {
  const t = useTranslations("run.issues.linked");
  return (
    <SafeLink
      to={frameHref(place, frame)}
      title={t("frameTitle")}
      className={`${edgeChip} border-border text-muted-foreground hover:border-rule hover:text-foreground`}
    >
      {t("frame", { seq: frame.seq })}
    </SafeLink>
  );
}

/** `.ev`: the edge, then the frames that carry it. */
export function EdgeChip({
  edge,
  frames = [],
  place,
}: {
  edge: Edge;
  frames?: readonly FrameAt[];
  place: Place;
}) {
  const t = useTranslations("run.issues.linked");
  return (
    <span className="flex flex-wrap items-center gap-[5px]">
      <span
        data-edge={edge}
        title={t(`edgeHelp.${edge}`)}
        className={`${edgeChip} ${EDGE_HUE[edge]}`}
      >
        {t(`edge.${edge}`)}
      </span>
      {[
        ...new Map(
          frames.map((frame): [string, FrameAt] => [frameKey(frame), frame]),
        ),
      ].map(([key, frame]) => (
        <FrameChip key={key} frame={frame} place={place} />
      ))}
    </span>
  );
}

/** A reference on the forge when its URL is one Oxagen can name, else the text alone. */
function ForgeRef({
  url,
  children,
}: {
  url: string | null;
  children: ReactNode;
}) {
  const target = parseGitHubUrl(url);
  if (target === null) return <>{children}</>;
  return (
    <GitHubLink to={target} className="text-link hover:underline">
      {children}
    </GitHubLink>
  );
}

/**
 * `.lw-item`: the glyph, then the bold reference, the lines under it and
 * the edge. `.lw-item { display:flex; gap:10px; padding:8px 0;
 * border-top:1px solid var(--border); font-size:12.5px }`, the first without
 * its rule.
 */
function Item({
  glyph,
  title,
  lines,
  edge,
  testId,
}: {
  glyph: string;
  title: ReactNode;
  /** The lines under the reference, by name, in the order they read; a null line is left out. */
  lines: Readonly<Record<string, ReactNode>>;
  edge: ReactNode;
  testId?: string;
}) {
  return (
    <li
      data-testid={testId}
      className="flex min-w-0 items-start gap-2.5 border-t border-border py-2 text-[12.5px] first:border-t-0"
    >
      <span
        aria-hidden="true"
        className="w-[18px] flex-none pt-px text-center font-mono text-dim"
      >
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        <b className="flex min-w-0 flex-wrap items-center gap-1.5 font-semibold text-foreground">
          {title}
        </b>
        {Object.entries(lines).map(([name, line]) =>
          line === null ? null : (
            <span
              key={name}
              className="block text-[11.5px] leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]"
            >
              {line}
            </span>
          ),
        )}
        <div className="mt-1">{edge}</div>
      </div>
    </li>
  );
}

/** The two lists' panel: `.lw .panel-b { padding:8px 14px 10px }`. */
function ListPanel({
  title,
  count,
  empty,
  children,
  testId,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
  testId: string;
}) {
  const locale = useLocale();
  return (
    <Panel
      title={title}
      aside={
        <Badge tone="quiet" dot={false}>
          {formatCount(count, locale)}
        </Badge>
      }
      flush
      testId={testId}
    >
      <div className="px-3.5 pb-2.5 pt-2">
        {count === 0 ? (
          <p className="py-2 text-[11.5px] text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col">{children}</ul>
        )}
      </div>
    </Panel>
  );
}

/** A repository's key: its URL, which names one repository on one forge. */
function repoName(repo: Repository) {
  return `${repo.owner}/${repo.name}`;
}

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

/** The frames a checkout was seen on: its first, and its last when it differs. */
function checkoutFrames(checkout: Checkout): FrameAt[] {
  return checkout.firstSeq === checkout.lastSeq
    ? [{ seq: checkout.firstSeq }]
    : [{ seq: checkout.firstSeq }, { seq: checkout.lastSeq }];
}

const ASSOCIATION_EDGE: Record<Pull["association"], Edge> = {
  recorded: "observed",
  head_commit: "commit",
  branch: "branch",
};

/** The number an output pull request names (`#482`, `a-intel/platform#482`), and its repository when it names one. */
function prNumberOf(
  node: RunOutputNode,
): { repo: string | null; n: number } | null {
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(node.name);
  if (match === null) return null;
  return { repo: match[1] ?? null, n: Number(match[2]) };
}

/** Whether an output pull request is this work read's pull request. */
function samePull(node: RunOutputNode, pull: Pull): boolean {
  const named = prNumberOf(node);
  if (named === null || named.n !== pull.number) return false;
  return named.repo === null || named.repo === repoName(pull.repository);
}

function Repositories({ work, place }: { work: RunWork; place: Place }) {
  const t = useTranslations("run.issues.linked");
  const machine = work.machine?.name ?? null;
  // One row per repository: its checkouts first, then any repository only a
  // pull request names.
  const rows = new Map<
    string,
    { repo: Repository | null; checkouts: Checkout[]; pulls: Pull[] }
  >();
  for (const checkout of work.checkouts) {
    const key = checkout.repository?.url ?? `checkout:${checkout.ref}`;
    const row = rows.get(key) ?? {
      repo: checkout.repository,
      checkouts: [],
      pulls: [],
    };
    row.checkouts.push(checkout);
    rows.set(key, row);
  }
  for (const pull of work.pullRequests) {
    const row = rows.get(pull.repository.url) ?? {
      repo: pull.repository,
      checkouts: [],
      pulls: [],
    };
    row.pulls.push(pull);
    rows.set(pull.repository.url, row);
  }
  const items = [...rows.entries()];
  return (
    <ListPanel
      title={t("repositories")}
      count={items.length}
      empty={t("noRepositories")}
      testId="run-linked-repositories"
    >
      {items.map(([key, row]) => {
        const lines = row.checkouts.map((checkout) =>
          [
            checkout.branch === null
              ? t("branchNotRecorded")
              : t("onBranch", { branch: checkout.branch }),
            checkout.headSha === null
              ? null
              : t("head", { sha: shortSha(checkout.headSha) }),
            machine === null ? checkout.path : `${machine}:${checkout.path}`,
          ]
            .filter((part) => part !== null)
            .join(" · "),
        );
        const observed = row.checkouts.length > 0;
        const edges: Edge[] = observed
          ? ["observed"]
          : [
              ...new Set(
                row.pulls.map((pull) => ASSOCIATION_EDGE[pull.association]),
              ),
            ];
        return (
          <Item
            key={key}
            testId="run-linked-repository"
            glyph={REPOSITORY_GLYPH}
            title={
              row.repo === null ? (
                <span className="text-muted-foreground">
                  {t("repoNotIdentified")}
                </span>
              ) : (
                <ForgeRef url={row.repo.url}>{repoName(row.repo)}</ForgeRef>
              )
            }
            lines={
              observed
                ? Object.fromEntries(
                    row.checkouts.map((checkout, i) => [
                      checkout.ref,
                      <span key={checkout.ref} className={mono}>
                        {lines[i]}
                      </span>,
                    ]),
                  )
                : { pulls: t("fromPullRequest") }
            }
            edge={
              <span className="flex flex-wrap gap-[5px]">
                {edges.map((edge) => (
                  <EdgeChip
                    key={edge}
                    edge={edge}
                    frames={
                      edge === "observed"
                        ? row.checkouts.flatMap(checkoutFrames)
                        : []
                    }
                    place={place}
                  />
                ))}
              </span>
            }
          />
        );
      })}
    </ListPanel>
  );
}

function Checks({ pull }: { pull: Pull }) {
  const t = useTranslations("run.issues.linked");
  if (pull.ci === null)
    return <span className="text-dim">{t("ciMissing")}</span>;
  const failed = pull.ci.runs.filter(
    (check) => check.conclusion !== null && FAILED_CHECK.has(check.conclusion),
  );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={CI_TONE[pull.ci.overall]}>
        {t(`ci.${pull.ci.overall}`)}
      </Badge>
      <span>
        {t("checks", {
          passed: pull.ci.counts.passed,
          failed: pull.ci.counts.failed,
          pending: pull.ci.counts.pending,
        })}
      </span>
      {pull.ci.complete ? null : <span>{t("checksPartial")}</span>}
      {failed.length === 0 ? null : (
        <span data-testid="run-linked-failed-checks">
          {t("failing")}{" "}
          {failed.map((check, i) => (
            // A check name repeats across workflow runs, so its position completes the key.
            <span key={`${check.name}/${String(i)}`}>
              {i === 0 ? null : ", "}
              <ForgeRef url={check.url}>{check.name}</ForgeRef>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Where an output landed on the forge, when the work read names its repository. */
function artifactUrl(
  node: RunOutputNode,
  repos: readonly Repository[],
): string | null {
  if (node.nameIsLocator) return null;
  const repo =
    repos.find((candidate) => repoName(candidate) === node.where) ??
    (repos.length === 1 ? repos[0] : undefined);
  if (repo === undefined) return null;
  if (node.kind === "commit" && /^[0-9a-f]{7,40}$/.test(node.name))
    return `${repo.url}/commit/${node.name}`;
  if (node.kind === "change") return `${repo.url}/tree/${node.name}`;
  return null;
}

function Artifacts({
  work,
  outputs,
  place,
}: {
  work: RunWork;
  outputs: Read<RunOutputs>;
  place: Place;
}) {
  const t = useTranslations("run.issues.linked");
  const tOut = useTranslations("run.outputs");
  const nodes = outputs.ok
    ? outputs.value.nodes.filter((node) => ARTIFACT_KINDS.has(node.kind))
    : [];
  // An output pull request that is one of the work read's is drawn once, on
  // the work read's row, with the frame that recorded it.
  const matched = new Map<Pull, RunOutputNode[]>();
  const loose: RunOutputNode[] = [];
  for (const node of nodes) {
    const pull =
      node.kind === "pr"
        ? work.pullRequests.find((candidate) => samePull(node, candidate))
        : undefined;
    if (pull === undefined) loose.push(node);
    else matched.set(pull, [...(matched.get(pull) ?? []), node]);
  }
  const repos = [
    ...new Map(
      [
        ...work.checkouts.flatMap((c) =>
          c.repository === null ? [] : [c.repository],
        ),
        ...work.pullRequests.map((pull) => pull.repository),
      ].map((repo) => [repo.url, repo]),
    ).values(),
  ];
  return (
    <ListPanel
      title={t("artifacts")}
      count={work.pullRequests.length + loose.length}
      empty={outputs.ok ? t("noArtifacts") : t("outputsUnread")}
      testId="run-linked-artifacts"
    >
      {work.pullRequests.map((pull) => {
        const recorded = matched.get(pull) ?? [];
        const frames = recorded.flatMap((node) =>
          node.seq === null ? [] : [{ seq: node.seq, chainRef: node.chainRef }],
        );
        const edge: Edge =
          recorded.length > 0 ? "observed" : ASSOCIATION_EDGE[pull.association];
        return (
          <Item
            key={`${pull.repository.url}/${String(pull.number)}`}
            testId="run-linked-pull"
            glyph={ARTIFACT_GLYPH.pr ?? ""}
            title={
              <>
                <ForgeRef url={pull.url}>
                  <span className={mono}>
                    {repoName(pull.repository)}#{pull.number}
                  </span>
                </ForgeRef>
                <Badge tone={PR_TONE[pull.state]}>
                  {t(`pr.${pull.state}`)}
                </Badge>
              </>
            }
            lines={{
              title: pull.title,
              checks: <Checks pull={pull} />,
              stale: pull.current ? null : t("stale"),
            }}
            edge={<EdgeChip edge={edge} frames={frames} place={place} />}
          />
        );
      })}
      {loose.map((node, i) => {
        const url = artifactUrl(node, repos);
        return (
          <Item
            // Two outputs may share a name and a frame; the position completes the key.
            key={`${node.kind}:${node.seq ?? ""}:${node.name}:${String(i)}`}
            testId="run-linked-artifact"
            glyph={ARTIFACT_GLYPH[node.kind] ?? "·"}
            title={
              <>
                <ForgeRef url={url}>
                  <span className={mono}>{node.name}</span>
                </ForgeRef>
                <Badge tone={OUTPUT_TONE[node.state]}>
                  {tOut(`state.${node.state}`)}
                </Badge>
              </>
            }
            lines={{
              where:
                node.where === null && node.note === null
                  ? null
                  : [node.where, node.note]
                      .filter((part) => part !== null)
                      .join(" · "),
              locator: node.nameIsLocator ? tOut("locator") : null,
            }}
            edge={
              <EdgeChip
                edge="observed"
                frames={
                  node.seq === null
                    ? []
                    : [{ seq: node.seq, chainRef: node.chainRef }]
                }
                place={place}
              />
            }
          />
        );
      })}
    </ListPanel>
  );
}

type DiffLine = {
  kind: "add" | "del" | "ctx" | "hunk";
  old: number | null;
  new: number | null;
  text: string;
};

/** A unified patch as numbered lines: the forge's hunks, read in order. */
function diffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldAt = 0;
  let newAt = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldAt = Number(hunk[1]);
      newAt = Number(hunk[2]);
      lines.push({ kind: "hunk", old: null, new: null, text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", old: null, new: newAt, text: raw.slice(1) });
      newAt += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", old: oldAt, new: null, text: raw.slice(1) });
      oldAt += 1;
    } else if (!raw.startsWith("\\")) {
      lines.push({ kind: "ctx", old: oldAt, new: newAt, text: raw.slice(1) });
      oldAt += 1;
      newAt += 1;
    }
  }
  return lines;
}

/**
 * `.diff { background:var(--void); border:1px solid var(--border);
 * border-radius:9px; font-size:11.5px; line-height:1.6; max-height:360px }`
 * (the `.lw-files` height) and `.dl` (two 34px number columns, then the
 * line), `.dl.add` / `.dl.del` at 14% of the allowed and denied hues.
 */
const DIFF_ROW: Record<DiffLine["kind"], string> = {
  add: "bg-success/15 text-foreground",
  del: "bg-warning/15 text-foreground",
  ctx: "",
  hunk: "text-dim",
};

function Diff({ patch }: { patch: string }) {
  return (
    <div className="mb-2.5 max-h-[360px] overflow-auto rounded-[9px] border border-border bg-void font-mono text-[11.5px] leading-[1.6]">
      {diffLines(patch).map((line, i) => (
        <div
          // A patch's lines are positional.
          // eslint-disable-next-line @eslint-react/no-array-index-key -- a patch never reorders
          key={i}
          className={`grid grid-cols-[34px_34px_minmax(0,1fr)] whitespace-pre ${DIFF_ROW[line.kind]}`}
        >
          <span className="select-none border-r border-border px-1.5 text-right text-dim">
            {line.old ?? ""}
          </span>
          <span className="select-none border-r border-border px-1.5 text-right text-dim">
            {line.new ?? ""}
          </span>
          <span className="whitespace-pre-wrap px-2.5 [overflow-wrap:anywhere]">
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({ added, removed }: { added: number; removed: number }) {
  const locale = useLocale();
  return (
    <span className="flex-none whitespace-nowrap font-mono text-[11px]">
      <b className={ADDED}>+{formatCount(added, locale)}</b>{" "}
      <b className={REMOVED}>−{formatCount(removed, locale)}</b>
    </span>
  );
}

/**
 * Files changed: one row per file the outputs recorded with a line stat (the
 * same set the Changes panel counts), with the forge's patch under it where a
 * pull request's diff carries that path, and the diffs the recorder captured
 * from a checkout under them.
 */
function FilesChanged({
  work,
  outputs,
  place,
}: {
  work: RunWork;
  outputs: Read<RunOutputs>;
  place: Place;
}) {
  const t = useTranslations("run.issues.linked");
  const locale = useLocale();
  const files = outputs.ok ? outputs.value.nodes.filter(isFileChange) : [];
  if (files.length === 0 && work.diffs.length === 0) return null;
  const added = files.reduce((sum, node) => sum + (node.stat?.added ?? 0), 0);
  const removed = files.reduce(
    (sum, node) => sum + (node.stat?.removed ?? 0),
    0,
  );
  const patches = new Map(
    work.pullRequests.flatMap((pull) =>
      (pull.diff?.files ?? []).flatMap((file) =>
        file.patch === null ? [] : [[file.path, file.patch] as const],
      ),
    ),
  );
  return (
    <Panel
      title={t("files")}
      testId="run-linked-files"
      flush
      aside={
        files.length === 0 ? undefined : (
          <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Stat added={added} removed={removed} />
            <span
              aria-hidden="true"
              className="inline-flex h-[7px] w-[60px] gap-px"
            >
              {/* `.dbar i.a` and `.dbar i.d`: the added and removed share of the lines. */}
              <i
                className="block h-full rounded-[1px] bg-success"
                style={{ flex: added }}
              />
              <i
                className="block h-full rounded-[1px] bg-warning"
                style={{ flex: removed }}
              />
            </span>
            <span>
              {t("filesCount", { count: files.length })} · {t("filesBasis")}
            </span>
          </span>
        )
      }
    >
      {files.length === 0 ? null : (
        <div className="px-4 pb-2 pt-0.5">
          {files.map((node, i) => {
            const patch = patches.get(node.name) ?? null;
            const summary = (
              <>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground">
                  {node.name}
                </span>
                {patch === null ? (
                  <span className="flex-none text-[11px] text-dim">
                    {t("noPatch")}
                  </span>
                ) : null}
                <span className="ml-auto">
                  <Stat
                    added={node.stat?.added ?? 0}
                    removed={node.stat?.removed ?? 0}
                  />
                </span>
              </>
            );
            const key = `${node.seq ?? ""}:${node.name}:${String(i)}`;
            return patch === null ? (
              <div
                key={key}
                data-testid="run-linked-file"
                className="flex min-w-0 items-center gap-2.5 border-t border-border py-2 pl-[18px] text-[12.5px] first:border-t-0"
              >
                {summary}
              </div>
            ) : (
              <details
                key={key}
                data-testid="run-linked-file"
                className="group border-t border-border first:border-t-0"
              >
                {/* `.lw-files summary::before { content:"▸" }`, `▾` when open. */}
                <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2.5 py-2 text-[12.5px] before:flex-none before:text-dim before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden">
                  {summary}
                </summary>
                <Diff patch={patch} />
              </details>
            );
          })}
        </div>
      )}
      {work.diffs.length === 0 ? null : (
        <PanelBody rule={files.length > 0}>
          <p className={`${eyebrowQuiet} mb-1.5`}>{t("captured")}</p>
          <ul className="flex flex-col">
            {work.diffs.map((diff) => (
              <li
                key={`${diff.checkoutRef}:${diff.seq}`}
                data-testid="run-linked-captured"
                className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border py-1.5 text-[11.5px] text-muted-foreground first:border-t-0"
              >
                <FrameChip frame={{ seq: diff.seq }} place={place} />
                <span>{t(`capture.${diff.completeness}`)}</span>
                {diff.digest === null ? null : (
                  <code
                    title={diff.digest}
                    className={`${mono} min-w-0 break-all text-[11px] text-dim`}
                  >
                    {`${diff.digest.slice(0, "sha256:".length + 12)}…`}
                  </code>
                )}
                {diff.limitations.length === 0 ? null : (
                  <span>{diff.limitations.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-dim">
            {t("capturedBasis", {
              count: formatCount(work.diffs.length, locale),
            })}
          </p>
        </PanelBody>
      )}
    </Panel>
  );
}

/** Every row the two lists draw, for the legend's count. */
function rowEdges(work: RunWork, outputs: Read<RunOutputs>): Edge[] {
  const repos = new Map<string, Edge>();
  for (const checkout of work.checkouts)
    repos.set(
      checkout.repository?.url ?? `checkout:${checkout.ref}`,
      "observed",
    );
  for (const pull of work.pullRequests)
    if (!repos.has(pull.repository.url))
      repos.set(pull.repository.url, ASSOCIATION_EDGE[pull.association]);
  const nodes = outputs.ok
    ? outputs.value.nodes.filter((node) => ARTIFACT_KINDS.has(node.kind))
    : [];
  const loose = nodes.filter(
    (node) =>
      node.kind !== "pr" ||
      !work.pullRequests.some((pull) => samePull(node, pull)),
  );
  return [
    ...repos.values(),
    ...work.pullRequests.map((pull) =>
      nodes.some((node) => node.kind === "pr" && samePull(node, pull))
        ? ("observed" as const)
        : ASSOCIATION_EDGE[pull.association],
    ),
    ...loose.map(() => "observed" as const),
  ];
}

/** `.lw-note`: the eyebrow, then what each edge means, and how many rows are inferred. */
function Legend({ edges }: { edges: readonly Edge[] }) {
  const t = useTranslations("run.issues.linked");
  const shown: Edge[] = ["observed", "stated"];
  if (edges.includes("commit")) shown.push("commit");
  if (edges.includes("branch")) shown.push("branch");
  const inferred = edges.filter((edge) => edge === "inferred").length;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px] text-dim">
      <p className={`${eyebrowQuiet} m-0`}>{t("title")}</p>
      {shown.map((edge) => (
        <span key={edge} className="inline-flex items-center gap-1.5">
          <span className={`${edgeChip} ${EDGE_HUE[edge]}`}>
            {t(`edge.${edge}`)}
          </span>
          {t(`edgeHelp.${edge}`)}
        </span>
      ))}
      <span
        className="inline-flex items-center gap-1.5"
        data-testid="run-linked-inferred"
      >
        <span className={`${edgeChip} ${EDGE_HUE.inferred}`}>
          {t("edge.inferred")}
        </span>
        {t("edgeHelp.inferred")}.{" "}
        {t("inferredCount", { inferred, total: edges.length })}
      </span>
    </div>
  );
}

function LinkedWorkBody({
  work,
  outputs,
  place,
}: {
  work: Read<RunWork>;
  outputs: Read<RunOutputs>;
  place: Place;
}) {
  const t = useTranslations("run.issues.linked");
  if (!work.ok)
    return (
      <section aria-label={t("title")} data-testid="run-linked-work">
        <p className={`${eyebrowQuiet} mb-3`}>{t("title")}</p>
        <ReadFailure read={work} section={t("title")} />
      </section>
    );
  return (
    <section
      aria-label={t("title")}
      data-testid="run-linked-work"
      className="flex flex-col"
    >
      <Legend edges={rowEdges(work.value, outputs)} />
      <div className="mb-3.5 grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        <Repositories work={work.value} place={place} />
        <Artifacts work={work.value} outputs={outputs} place={place} />
      </div>
      <FilesChanged work={work.value} outputs={outputs} place={place} />
      {work.value.complete ? null : (
        <p role="status" className={`${note} mt-3.5`}>
          {t("incomplete")}
        </p>
      )}
    </section>
  );
}

/**
 * Linked work, once the work read the page started has answered. Provider
 * latency (pull requests, checks, diffs) streams inside the tab's boundary,
 * so the issues above it never wait on GitHub.
 */
export function LinkedWork({
  work,
  ...rest
}: {
  work: Promise<Read<RunWork>>;
  outputs: Read<RunOutputs>;
  place: Place;
}) {
  return <LinkedWorkBody work={use(work)} {...rest} />;
}

export function LinkedWorkLoading() {
  const t = useTranslations("run.issues.linked");
  return (
    <section aria-label={t("title")} aria-busy="true">
      <p className={`${eyebrowQuiet} mb-3`}>{t("title")}</p>
      <p role="status" className="text-xs text-muted-foreground">
        {t("loading")}
      </p>
    </section>
  );
}
