// The prompt is the brand kit's script; what this app owns is loading it once,
// after hydration, with the catalogue's words rather than the script's English
// defaults. The card's own behaviour (who sees it, the cookie) is tested in the
// kit, beside the script (oxagen-brand ui/src/lib/install-prompt.test.ts).
import Script from "next/script";
import { describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const { InstallPrompt } = await import("./install-prompt");

describe("InstallPrompt", () => {
  it("loads the vendored script after hydration, with the app icon", async () => {
    const el = await InstallPrompt();
    expect(el.type).toBe(Script);
    expect(el.props).toMatchObject({
      src: "/pwa/install-prompt.js",
      strategy: "afterInteractive",
      "data-icon": "/pwa/icon-192.png",
    });
  });

  it("passes every string from the catalogue", async () => {
    const { props } = await InstallPrompt();
    expect(props).toMatchObject({
      "data-title": "Add Oxagen to your home screen",
      "data-body": "Open it like an app, full screen, one tap away.",
      "data-body-ios": "Tap Share, then Add to Home Screen.",
      "data-install": "Add to home screen",
      "data-dismiss": "Not now",
    });
  });
});
