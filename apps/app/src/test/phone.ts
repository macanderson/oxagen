// The phone shell at 400 px (ARCHITECTURE.md §1.2, §6.2 J14). jsdom evaluates
// no media query, so this applies the rules inside src/ui/phone.css's one
// phone block unconditionally and hands the test a 400 px container: a
// component test then reads computed styles off the real rules.
import { readFileSync } from "node:fs";
import path from "node:path";

const PHONE_CSS = path.join(process.cwd(), "src/ui/phone.css");
/** Tailwind's md breakpoint: below it the page is a phone. */
const PHONE_QUERY = "(width < 48rem)";

function isMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return "media" in rule && "cssRules" in rule;
}

export function phoneWidth(): { container: HTMLElement; restore: () => void } {
  const parsed = document.createElement("style");
  parsed.textContent = readFileSync(PHONE_CSS, "utf8");
  document.head.append(parsed);
  const blocks = [...(parsed.sheet?.cssRules ?? [])].filter(isMediaRule);
  parsed.remove();
  const [block] = blocks;
  if (blocks.length !== 1 || block?.media.mediaText !== PHONE_QUERY)
    throw new Error(`phone.css holds one ${PHONE_QUERY} block`);

  const style = document.createElement("style");
  style.textContent = [...block.cssRules].map((r) => r.cssText).join("\n");
  document.head.append(style);
  const container = document.createElement("div");
  container.style.width = "400px";
  document.body.append(container);
  return {
    container,
    restore: () => {
      style.remove();
      container.remove();
    },
  };
}
