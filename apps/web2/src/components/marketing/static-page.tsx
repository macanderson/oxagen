import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Renders one migrated apps/web static page. `name` selects a pair of files
 * under `src/content/marketing/`: `<name>.html` (the page's `<body>`
 * content, extracted from the original static HTML — see that directory's
 * README) and `<name>.css` (the page's own `<style>` block from the
 * original `<head>`, e.g. the hero layout).
 *
 * This is a Server Component: the files are read once per server instance,
 * not per request, and the result is plain markup with no client-side
 * React behind it — matching the source site, which had none either. The
 * interactive bits (nav, drawer, reveal-on-scroll, lead forms) come from
 * `public/assets/oxagen.js`, loaded once in the marketing route group's
 * layout.
 */
export function StaticMarketingPage({ name }: { name: string }) {
  const dir = join(process.cwd(), "src/content/marketing");
  const html = readFileSync(join(dir, `${name}.html`), "utf8");
  const css = readFileSync(join(dir, `${name}.css`), "utf8");

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
