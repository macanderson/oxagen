// The steering repo's link, labelled with its full name. A URL that is not a
// github.com or gitlab.com page renders as the name alone, because the link
// components take only a checked URL.
import { parseGitHubUrl } from "@/shared/github-url";
import { parseGitLabUrl } from "@/shared/gitlab-url";
import { linkText, mono } from "@/ui/control-styles";
import { GitHubLink, GitLabLink } from "@/ui/navigation";
import type { SteeringRepoView } from "./types";

const linkClass = `${linkText} ${mono}`;

export function SteeringRepositoryLink({
  provider,
  repository,
  testId,
}: {
  provider: SteeringRepoView["provider"];
  repository: { fullName: string; url: string };
  testId: string;
}) {
  const gitlab = provider === "gitlab" ? parseGitLabUrl(repository.url) : null;
  if (gitlab !== null)
    return (
      <GitLabLink to={gitlab} data-testid={testId} className={linkClass}>
        {repository.fullName}
      </GitLabLink>
    );
  const github = provider === "gitlab" ? null : parseGitHubUrl(repository.url);
  if (github !== null)
    return (
      <GitHubLink to={github} data-testid={testId} className={linkClass}>
        {repository.fullName}
      </GitHubLink>
    );
  return (
    <span data-testid={testId} className={mono}>
      {repository.fullName}
    </span>
  );
}
