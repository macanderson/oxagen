import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

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

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
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
