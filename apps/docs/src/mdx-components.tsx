import { Callout as FumadocsCallout } from "fumadocs-ui/components/callout";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";

import { LatestDownloads } from "@/components/mdx/latest-downloads";
import { Mermaid } from "@/components/mdx/mermaid";
import { ReleaseDownloads } from "@/components/mdx/release-downloads";
import { ReleaseList } from "@/components/mdx/release-list";
import { TuiGraphSearch } from "@/components/tui/tui-graph-search";
import { TuiInteractiveAnswer } from "@/components/tui/tui-interactive-answer";
import { TuiLogin } from "@/components/tui/tui-login";
import { TuiReplBanner } from "@/components/tui/tui-repl-banner";
import { TuiSettingsShow } from "@/components/tui/tui-settings-show";
import { TuiSlashMenu } from "@/components/tui/tui-slash-menu";

/**
 * Fumadocs' callout with the ox-callout class, the hook src/app/global.css
 * uses to give a callout the house card corner and no shadow at rest.
 */
function Callout({ className, ...props }: ComponentProps<typeof FumadocsCallout>) {
  return (
    <FumadocsCallout
      className={className ? `ox-callout ${className}` : "ox-callout"}
      {...props}
    />
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Callout,
    LatestDownloads,
    Mermaid,
    ReleaseDownloads,
    ReleaseList,
    TuiGraphSearch,
    TuiInteractiveAnswer,
    TuiLogin,
    TuiReplBanner,
    TuiSettingsShow,
    TuiSlashMenu,
    ...components,
  };
}
