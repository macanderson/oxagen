// The not-found page outside the shell: an address no route answers, or a
// notFound() above every organization (a stranger to an organization is one).
// It draws the design's state shape, the empty glyph, a heading, one sentence
// and one way back, and its heading is the page's one h1 because nothing else
// on the page has a heading.
import { getTranslations } from "next-intl/server";
import { routes } from "@/shared/safe-path";
import { buttonPrimary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { StateWrap } from "@/ui/state-wrap";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <StateWrap
        heading="h1"
        testId="not-found"
        tone="neutral"
        title={t("title")}
        actions={
          <SafeLink to={routes.root()} className={buttonPrimary}>
            {t("home")}
          </SafeLink>
        }
      >
        {t("body")}
      </StateWrap>
    </main>
  );
}
