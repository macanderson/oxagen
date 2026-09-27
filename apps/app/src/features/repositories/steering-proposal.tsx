"use client";
// What a link or an unlink proposed (ADR-212). `workspace.toml` on the
// steering repository decides which repositories are linked, so a link or an
// unlink opens a steering PR and takes effect when a person merges it. This
// block names that PR, links its number to the PR on GitHub, and says what
// merging it does. A link that `workspace.toml` lists already opens no PR, and
// the block says the next steering sync links it.
//
// The repository dialog, the unlink confirm, and the init wizard each show
// it where the write answered.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { SteeringPullRequest } from "@/data/contracts/repository";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { PullRequestLink } from "@/ui/navigation";
import { code } from "./parts";

export function SteeringProposal({
  action,
  fullName,
  steeringPullRequest,
  testId,
}: {
  action: "link" | "unlink";
  /** `owner/name` of the repository the PR adds or removes. */
  fullName: string;
  /**
   * The PR the write opened. Null on a link means `workspace.toml` lists the
   * repository already. The unlink dialog passes a PR every time. A null
   * there shows only the line that says to merge the steering PR.
   */
  steeringPullRequest: SteeringPullRequest | null;
  testId: string;
}) {
  const t = useTranslations("repositories.steering");
  if (steeringPullRequest === null)
    return (
      <div
        role="status"
        data-testid={testId}
        data-state={action === "link" ? "listed" : "proposed"}
        className="text-[13px] leading-relaxed"
      >
        <p>
          {action === "link"
            ? t.rich("linkListed", { repository: fullName, code })
            : t("unlinkMerge")}
        </p>
      </div>
    );
  const url = parsePullRequestUrl(steeringPullRequest.url);
  const pr = (chunks: ReactNode) =>
    url === null ? (
      chunks
    ) : (
      <PullRequestLink
        to={url}
        data-testid={`${testId}-link`}
        className="font-medium text-link underline"
      >
        {chunks}
      </PullRequestLink>
    );
  const values = {
    repository: fullName,
    number: steeringPullRequest.number,
    code,
    pr,
  };
  const lead =
    action === "link"
      ? steeringPullRequest.reused
        ? t.rich("linkReused", values)
        : t.rich("linkProposed", values)
      : steeringPullRequest.reused
        ? t.rich("unlinkReused", values)
        : t.rich("unlinkProposed", values);
  return (
    <div
      role="status"
      data-testid={testId}
      data-state={steeringPullRequest.reused ? "reused" : "proposed"}
      className="flex flex-col gap-1 text-[13px] leading-relaxed"
    >
      <p>{lead}</p>
      <p className="font-medium">
        {action === "link" ? t("linkMerge") : t("unlinkMerge")}
      </p>
    </div>
  );
}
