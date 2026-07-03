import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { IllustrationAgent } from "@/components/illustrations/illustration-agent";
import { IllustrationApi } from "@/components/illustrations/illustration-api";
import { IllustrationCli } from "@/components/illustrations/illustration-cli";
import { IllustrationGettingStarted } from "@/components/illustrations/illustration-getting-started";
import { IllustrationMcp } from "@/components/illustrations/illustration-mcp";
import { IllustrationOverview } from "@/components/illustrations/illustration-overview";
import { IllustrationPlugins } from "@/components/illustrations/illustration-plugins";
import { IllustrationSecurity } from "@/components/illustrations/illustration-security";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    IllustrationAgent,
    IllustrationApi,
    IllustrationCli,
    IllustrationGettingStarted,
    IllustrationMcp,
    IllustrationOverview,
    IllustrationPlugins,
    IllustrationSecurity,
    ...components,
  };
}
