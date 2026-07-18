"use client";

// Renders a Mermaid diagram from a `chart` string. Follows the official
// Fumadocs recipe (fumadocs-ui + mermaid + next-themes): lazy-loads the
// `mermaid` package on the client, re-renders when the resolved fumadocs
// theme (light/dark) changes, and caches both the module import and each
// chart+theme render so switching pages/themes doesn't re-render diagrams
// that were already rendered.
import { use, useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";

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

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(
    cachePromise("mermaid", () => import("mermaid")),
  );

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    fontFamily: "inherit",
    themeCSS: "margin: 1.5rem auto 0;",
    theme: resolvedTheme === "dark" ? "dark" : "default",
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () => {
      return mermaid.render(id, chart.replaceAll("\\n", "\n"));
    }),
  );

  return (
    <div
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      // Mermaid's own SVG output is trusted (it sanitises its own markup);
      // the chart source is authored docs content, never raw end-user HTML.
      dangerouslySetInnerHTML={{ __html: svg }}
      className="max-w-full overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}
