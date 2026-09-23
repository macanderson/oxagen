// The two panels under the Records shelf's list (roadmap
// pages/steering-records.md): On disk, the `.oxagen/` tree on the main
// repository's production branch as GitHub holds it now, and Injection
// points, the five places Oxagen's steering enters a harness's context.
//
// On disk draws the tree it read, never a picture of one: every path is a
// path get_repository_tree returned, and the comment beside a path says what
// that file or directory is for. A workspace with no main repository, a read
// that failed, and a branch with no `.oxagen/` each say so instead.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { OxagenTree } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { SteeringReadFailure } from "./read-failure";
import { Badge } from "@/ui/badge";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";

const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";

/** What a path under `.oxagen/` is for, keyed by the path or its directory. */
type Comment =
  | "workspace"
  | "governance"
  | "promotions"
  | "skills"
  | "ontology"
  | "proposals"
  | "agents";

const FILE_COMMENTS: Readonly<Record<string, Comment>> = {
  "workspace.toml": "workspace",
  "rules/governance.toml": "governance",
  "rules/promotions.jsonl": "promotions",
};
const DIR_COMMENTS: Readonly<Record<string, Comment>> = {
  skills: "skills",
  ontology: "ontology",
  proposals: "proposals",
  agents: "agents",
};

type Line = { depth: number; name: string; comment: Comment | null };

/**
 * The tree's lines, a directory before what it holds: `rules/` then its
 * files, each indented two spaces a level. The paths arrive sorted.
 */
export function treeLines(files: readonly string[]): Line[] {
  const lines: Line[] = [];
  const opened = new Set<string>();
  for (const path of [...files].sort()) {
    const parts = path.split("/");
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const dir = parts.slice(0, depth + 1).join("/");
      if (opened.has(dir)) continue;
      opened.add(dir);
      lines.push({
        depth,
        name: `${parts[depth] ?? ""}/`,
        comment: depth === 0 ? (DIR_COMMENTS[dir] ?? null) : null,
      });
    }
    lines.push({
      depth: parts.length - 1,
      name: parts.at(-1) ?? path,
      comment: FILE_COMMENTS[path] ?? null,
    });
  }
  return lines;
}

function TreeState({ tree }: { tree: Read<OxagenTree> }) {
  const t = useTranslations("steering.records.disk");
  if (!tree.ok) {
    return (
      <p data-tree="failed" className="text-[13px] text-muted-foreground">
        {t("failed", {
          code: tree.reason === "error" ? tree.code : tree.reason,
        })}
      </p>
    );
  }
  const value = tree.value;
  if (value.state === "unbound") {
    return (
      <p data-tree="unbound" className="text-[13px] text-muted-foreground">
        {t("unbound")}
      </p>
    );
  }
  if (value.files.length === 0) {
    return (
      <p data-tree="absent" className="text-[13px] text-muted-foreground">
        {t.rich("absent", {
          repository: value.repository,
          branch: value.branch,
          code: (chunks) => (
            <code className="font-mono text-[12px]">{chunks}</code>
          ),
        })}
      </p>
    );
  }
  const lines = treeLines(value.files);
  const width = Math.max(
    ...lines.map((line) => line.depth * 2 + 2 + line.name.length),
  );
  const commentOf = (comment: Comment) =>
    comment === "governance"
      ? t("comments.governance", { mode: value.mode })
      : t(`comments.${comment}`);
  return (
    <>
      <p className="mb-2 font-mono text-[11.5px] text-dim" data-tree="at">
        {t("at", {
          repository: value.repository,
          branch: value.branch,
          head: value.head === null ? t("noHead") : value.head.slice(0, 7),
        })}
      </p>
      <pre
        data-tree="read"
        className="max-h-[420px] overflow-auto rounded-lg border border-border bg-hl px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-foreground"
      >
        {".oxagen/\n"}
        {lines.map((line, index) => {
          const text = `${"  ".repeat(line.depth + 1)}${line.name}`;
          return (
            <span key={`${String(index)}-${line.name}`} data-path-line="">
              {text}
              {line.comment === null ? null : (
                <span className="text-dim">
                  {" ".repeat(Math.max(1, width - text.length + 3))}
                  {`# ${commentOf(line.comment)}`}
                </span>
              )}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </>
  );
}

export function OnDisk({ tree }: { tree: Read<OxagenTree> }) {
  const t = useTranslations("steering.records.disk");
  return (
    <section
      aria-labelledby="steering-on-disk"
      data-testid="records-on-disk"
      className={panel}
    >
      <div className={panelHeader}>
        <h3 id="steering-on-disk" className={panelTitle}>
          {t("title")}
        </h3>
      </div>
      <div className={`${panelBody} flex flex-col gap-3`}>
        <div>
          <TreeState tree={tree} />
        </div>
        <p className={note}>
          {t.rich("note", {
            code: (chunks) => (
              <code className="font-mono text-[12px]">{chunks}</code>
            ),
          })}
        </p>
      </div>
    </section>
  );
}

const POINTS = ["1", "2", "3", "4", "5"] as const;

export function InjectionPoints() {
  const t = useTranslations("steering.records.injection");
  const code = (chunks: ReactNode) => (
    <code className="font-mono text-[12px]">{chunks}</code>
  );
  return (
    <section
      aria-labelledby="steering-injection"
      data-testid="records-injection"
      className={panel}
    >
      <div className={panelHeader}>
        <h3 id="steering-injection" className={panelTitle}>
          {t("title")}
        </h3>
        <Badge tone="quiet" dot={false}>
          {t("badge")}
        </Badge>
      </div>
      <div className={panelBody}>
        <p className="mb-3 text-[12.5px] text-muted-foreground">{t("lead")}</p>
        <ol className="flex flex-col gap-3">
          {POINTS.map((point) => (
            <li
              key={point}
              data-point={point}
              className="relative pl-5 before:absolute before:left-0 before:top-[5px] before:size-2 before:rounded-full before:bg-gold"
            >
              <span className="flex gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
                <span className="font-mono">{point}</span>
                {t(`points.${point}.head`)}
              </span>
              <span className="text-[13px] text-foreground">
                {t.rich(`points.${point}.body`, { code })}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The Published records panel when a page of the whole read failed. */
export function RecordsReadFailure({
  read,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
}) {
  const t = useTranslations("steering.records");
  return (
    <section aria-labelledby="steering-records" className={panel}>
      <div className={panelHeader}>
        <h3 id="steering-records" className={panelTitle}>
          {t("title")}
        </h3>
      </div>
      <div className={panelBody}>
        <SteeringReadFailure read={read} section={t("title")} />
      </div>
    </section>
  );
}
