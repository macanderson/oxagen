"use client";

// Renders a Mermaid diagram from a `chart` string, drawn to match the
// hand-built diagrams on stella.oxagen.sh: outline boxes, one hairline weight,
// open chevron arrowheads, monospace labels, and a gold outline on the one or
// two nodes a diagram is about (mark them in the chart with `:::accent`).
//
// Mermaid is configured for layout and type only. Every colour lives in the
// `.ox-mermaid` rules in src/app/global.css, as house tokens, so light and
// dark are a stylesheet swap: a theme change never re-renders a diagram.
//
// Follows the Fumadocs recipe otherwise: lazy-load `mermaid` on the client and
// cache both the module import and each rendered chart.
import { use, useEffect, useId, useState } from "react";

// The house system has no mono face; code takes the system monospace stack
// (see --font-mono in @oxagen/ui globals.css). Mermaid measures label widths
// with this family, so it must be a concrete stack, not a var() reference.
const FALLBACK_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';

export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(
  key: string,
  setPromise: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function monoStack(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return value || FALLBACK_MONO;
}

/**
 * Turn Mermaid's filled triangle arrowheads into open chevrons, the stroke
 * the stylesheet gives every wire. A triangle path with its closing `z`
 * removed is already a chevron; the state diagram's notched "barb" is not, so
 * it is redrawn.
 */
function openArrowheads(svg: string): string {
  return svg.replace(/<marker\b[^>]*>[\s\S]*?<\/marker>/g, (marker) =>
    marker
      .replace('d="M 19,7 L9,13 L14,7 L9,1 Z"', 'd="M 9,1 L19,7 L9,13"')
      .replace(/(<path\b[^>]*\bd="[^"]*?)\s*[zZ]"/g, '$1"'),
  );
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { default: mermaid } = use(
    cachePromise("mermaid", () => import("mermaid")),
  );

  const mono = monoStack();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    fontFamily: mono,
    themeVariables: { fontFamily: mono, fontSize: "12px" },
    themeCSS: "margin: 1.5rem auto 0;",
    flowchart: {
      curve: "basis",
      padding: 10,
      nodeSpacing: 32,
      rankSpacing: 40,
    },
    sequence: {
      actorFontFamily: mono,
      messageFontFamily: mono,
      noteFontFamily: mono,
      actorFontSize: 12,
      messageFontSize: 12,
      noteFontSize: 11,
      // One row of participant boxes: the repeat along the bottom is height
      // the reader scrolls past for nothing.
      mirrorActors: false,
      boxMargin: 8,
      messageMargin: 32,
    },
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}`, async () => {
      const result = await mermaid.render(id, chart.replaceAll("\\n", "\n"));
      return { ...result, svg: openArrowheads(result.svg) };
    }),
  );

  return (
    <div
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      // `securityLevel: "loose"` above turns Mermaid's label sanitiser OFF, so
      // this SVG is NOT sanitised — raw HTML and `click` directives in a chart
      // reach the DOM verbatim. That is acceptable only because every `chart`
      // string is authored MDX committed to this repo, never anything a reader
      // supplies. If a chart ever becomes user-supplied, this must move to
      // `securityLevel: "strict"` before that lands.
      dangerouslySetInnerHTML={{ __html: svg }}
      className="ox-mermaid max-w-full overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}
