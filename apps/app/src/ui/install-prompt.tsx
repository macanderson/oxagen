// The house install prompt: a small card that offers to put Oxagen on the home
// screen the first time a person opens it on a phone or tablet. The card is
// the brand kit's framework-free script (oxagen-brand pwa/install-prompt.js),
// vendored to public/ by tools/scripts/sync-brand-assets.mjs, so every Oxagen
// frontend shows the same card and remembers a dismissal the same way: the
// `ox_install_prompt` cookie, for a year. This component only loads it and
// hands it the catalogue's strings.
import Script from "next/script";
import { getTranslations } from "next-intl/server";

export async function InstallPrompt() {
  const t = await getTranslations("app.install");
  return (
    <Script
      src="/pwa/install-prompt.js"
      strategy="afterInteractive"
      data-icon="/pwa/icon-192.png"
      data-title={t("title")}
      data-body={t("body")}
      data-body-ios={t("bodyIos")}
      data-install={t("install")}
      data-dismiss={t("dismiss")}
    />
  );
}
