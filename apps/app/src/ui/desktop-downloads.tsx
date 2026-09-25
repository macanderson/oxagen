// Install the Oxagen app: the newest installer for each platform, shown
// wherever a person is told to enroll a machine. The enrollment command is
// `oxagen agent enroll`, and the app is what puts `oxagen` and `tacho` on the
// machine's PATH (apps/desktop/README.md), so the links come before the
// command.
//
// Every platform is listed, in the downloads page's order, on the server and
// the client alike. The page does not guess the visitor's system: the machine
// being enrolled is often not the one showing this page, and a list that
// reordered after hydration would move under a pointer.
//
// No directive and no hook but the translator: the agent's server-rendered
// Enrollment section and the client dialogs render the same markup. The
// region is named by the heading's text rather than by a generated id, which
// would need `useId` on the server.
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import {
  DESKTOP_DOWNLOADS,
  DESKTOP_DOWNLOADS_PAGE,
} from "@/shared/desktop-downloads";
import { linkText, mono } from "./control-styles";
import { DesktopDownloadsPageLink, DesktopInstallerLink } from "./navigation";

export function DesktopDownloads() {
  const t = useTranslations("ui.desktopDownloads");
  return (
    <section
      data-testid="desktop-downloads"
      aria-label={t("title")}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t.rich("lead", {
          code: (chunks) => (
            <code className={`${mono} rounded bg-muted px-1`}>{chunks}</code>
          ),
        })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {DESKTOP_DOWNLOADS.map((group) => (
          <Fragment key={group.platform}>
            <dt className="text-muted-foreground">
              {t(`platforms.${group.platform}`)}
            </dt>
            <dd>
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {group.installers.map((installer) => (
                  <li key={installer.key}>
                    <DesktopInstallerLink
                      to={installer.url}
                      data-testid={`desktop-download-${installer.key}`}
                      className={linkText}
                    >
                      {t(`installers.${installer.key}`)}
                    </DesktopInstallerLink>
                  </li>
                ))}
              </ul>
            </dd>
          </Fragment>
        ))}
      </dl>
      <p
        className="max-w-prose text-xs text-muted-foreground"
        data-testid="desktop-downloads-macos-first-launch"
      >
        {t("macosFirstLaunch")}
      </p>
      <p className="text-xs">
        <DesktopDownloadsPageLink
          to={DESKTOP_DOWNLOADS_PAGE}
          data-testid="desktop-downloads-all"
          className={linkText}
        >
          {t("all")}
        </DesktopDownloadsPageLink>
      </p>
    </section>
  );
}
