// The diff a Context PR's branch makes (#5077), read from the host when the
// page opens (get_context_pr_diff). It loads inside its own boundary, so a
// slow or refusing host leaves the rest of the page standing. A merged or
// closed pull request's branch is deleted, so the section says so and links
// to the pull request's files on the host instead.
import { useTranslations } from "next-intl";
import type { ContextPrDiff } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import type { PullRequestUrl } from "@/shared/pull-request-url";
import { linkText, mono } from "@/ui/control-styles";
import { PullRequestLink } from "@/ui/navigation";
import { lineDiff } from "./line-diff";
import { SteeringReadFailure } from "./read-failure";
import { Section } from "./section";

const SIGN = { same: " ", removed: "-", added: "+" } as const;

const LINE_TONE = {
  same: "",
  removed: "bg-error/10",
  added: "bg-success/10",
} as const;

function FileDiff({ file }: { file: ContextPrDiff["files"][number] }) {
  const t = useTranslations("steering.pr.diff");
  const lines = lineDiff(file.before, file.after);
  return (
    <div
      data-diff-file={file.path}
      className="flex flex-col gap-1.5 rounded-md border border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className={`${mono} text-xs text-foreground break-all`}>
          {file.path}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(`statuses.${file.status}`)}
        </span>
      </div>
      <table
        aria-label={t("fileLabel", { path: file.path })}
        className={`${mono} w-full border-collapse text-[11.5px]`}
      >
        <tbody>
          {lines.map((line) => (
            <tr
              // A removed line is unique by its base number, an added one by
              // its head number, and a kept one by both.
              key={`${line.kind}:${String(line.before)}:${String(line.after)}`}
              data-line={line.kind}
              className={LINE_TONE[line.kind]}
            >
              <td className="w-10 select-none px-2 text-right text-dim">
                {line.before ?? ""}
              </td>
              <td className="w-10 select-none px-2 text-right text-dim">
                {line.after ?? ""}
              </td>
              <td className="w-4 select-none text-dim" aria-hidden="true">
                {SIGN[line.kind]}
              </td>
              <td className="whitespace-pre-wrap break-all pe-3 text-foreground">
                <span className="sr-only">{t(`lines.${line.kind}`)} </span>
                {line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {file.truncated ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {t("truncated")}
        </p>
      ) : null}
    </div>
  );
}

/** The diff's body for a read, drawn without its own reads so a test renders it whole. */
export function ContextPrDiffBody({
  read,
  prUrl,
}: {
  read: Read<ContextPrDiff>;
  prUrl: PullRequestUrl | null;
}) {
  const t = useTranslations("steering.pr.diff");
  const title = t("title");
  if (!read.ok) {
    return (
      <Section id="context-pr-diff" title={title}>
        <SteeringReadFailure read={read} section={title} />
      </Section>
    );
  }
  const diff = read.value;
  return (
    <Section id="context-pr-diff" title={title} data-diff-state={diff.state}>
      {diff.state === "no_pr" ? (
        <p className="text-sm text-muted-foreground">{t("noPr")}</p>
      ) : diff.state === "settled" ? (
        <p className="text-sm text-muted-foreground">
          {t("settled")}{" "}
          {prUrl === null ? null : (
            <PullRequestLink to={prUrl} className={linkText}>
              {t("openFiles")}
            </PullRequestLink>
          )}
        </p>
      ) : diff.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {diff.baseRef === null || diff.headSha === null ? null : (
            <p className="text-xs text-muted-foreground">
              {t("against", {
                base: diff.baseRef,
                head: diff.headSha.slice(0, 7),
              })}
            </p>
          )}
          {diff.files.map((file) => (
            <FileDiff key={file.path} file={file} />
          ))}
          {diff.moreFiles ? (
            <p className="text-xs text-muted-foreground">{t("moreFiles")}</p>
          ) : null}
        </div>
      )}
    </Section>
  );
}

export async function ContextPrDiffSection({
  ctx,
  source,
  proposalId,
  prUrl,
}: {
  ctx: WsCtx;
  source: DataSource;
  proposalId: string;
  prUrl: PullRequestUrl | null;
}) {
  const read = await source.steering.contextPrDiff(ctx, proposalId);
  return <ContextPrDiffBody read={read} prUrl={prUrl} />;
}

export function DiffLoading() {
  const t = useTranslations("steering.pr.diff");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid="context-pr-diff-loading"
      className="skeleton h-32 rounded-md"
    />
  );
}
