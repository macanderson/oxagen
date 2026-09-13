import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Mermaid } from "@/components/mdx/mermaid";
import { TuiGraphSearch } from "@/components/tui/tui-graph-search";
import { TuiInteractiveAnswer } from "@/components/tui/tui-interactive-answer";
import { TuiLogin } from "@/components/tui/tui-login";
import { TuiReplBanner } from "@/components/tui/tui-repl-banner";
import { TuiSettingsShow } from "@/components/tui/tui-settings-show";
import { TuiSlashMenu } from "@/components/tui/tui-slash-menu";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Mermaid,
    TuiGraphSearch,
    TuiInteractiveAnswer,
    TuiLogin,
    TuiReplBanner,
    TuiSettingsShow,
    TuiSlashMenu,
    ...components,
  };
}
