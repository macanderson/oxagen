"use client";
// The user menu behind the avatar (mockup `userMenu()`): who is signed in,
// the four tabs of the Account dialog as deep links, the theme switch, and
// sign out. The mockup's fifth link is an onboarding demo and is not a
// product item.
//
// The trigger draws `viewer.avatarUrl` through the app's one avatar renderer
// (src/ui/avatar.tsx), which falls back to initials when the person has set no
// avatar or the stored value is malformed.
import { Menu } from "@base-ui/react/menu";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { Avatar } from "@/ui/avatar";
import { useNavigate } from "@/ui/navigation";
import { initials } from "./format";
import { useRecoveryCodeVault } from "./recovery-code-vault";
import { liveSignOut } from "./session-client";
import type { ShellData } from "./shell-data";
import { type AccountTab, useShellState } from "./shell-state";
import { nextTheme } from "./theme";

const itemClass =
  "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-menu-item-fg outline-none data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg";

const LINKS: readonly { tab: AccountTab; testId: string }[] = [
  { tab: "profile", testId: "open-account" },
  { tab: "preferences", testId: "open-preferences" },
  { tab: "security", testId: "open-security" },
  { tab: "privacy", testId: "open-privacy" },
];

export function UserMenu({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const navigate = useNavigate();
  const { theme, setTheme, openAccount } = useShellState();
  const vault = useRecoveryCodeVault(data.viewer.id);
  const { viewer } = data;
  const displayName = viewer.name ?? viewer.email;

  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    // Signing out ends the session the recovery codes were issued to, and a
    // client-side `replace` runs no `beforeunload`, so the browser cannot ask.
    // With a rotation on the wire or its set unsaved, that throws away the only
    // copy of a set Better Auth has already swapped in for the old one. So the
    // menu takes the person back to the codes instead; sign out works again
    // once they are saved.
    if (vault.rotating || vault.codes !== null || vault.uncertain) {
      openAccount("security");
      return;
    }
    if (signingOut) return;
    setSigningOut(true);
    setSignOutFailed(false);
    let ended: boolean;
    try {
      ended = await liveSignOut();
    } catch {
      // A thrown call is the same outcome as a refused one: the session may
      // still be open, so nothing may claim it closed.
      ended = false;
    } finally {
      setSigningOut(false);
    }
    if (ended) {
      // `replace` re-renders the server tree, so no chrome for the old session
      // survives, and the sign-in page is where a signed-out person belongs.
      navigate.replace(routes.login());
      return;
    }
    // It did NOT end. This used to navigate from `finally`, so a refused or
    // unreachable sign-out looked identical to one that worked: the page left,
    // the person believed the session was closed, and the cookie was still
    // valid. Sign out is what someone reaches for when they do not trust the
    // machine they are on, so saying it happened when it did not is the one
    // failure this control cannot have. The menu stays open, says so, and the
    // press can be repeated.
    setSignOutFailed(true);
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="user-menu-trigger"
        aria-label={t("topbar.userMenu", { name: displayName })}
        className="flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar
          value={viewer.avatarUrl}
          initials={initials(displayName)}
          size={30}
          testId="user-menu-avatar"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup className="w-[250px] rounded-xl border border-menu-popup-border bg-menu-popup-bg p-1.5 text-menu-popup-fg shadow-lg outline-none">
            <div className="mb-1 border-b border-menu-separator px-2.5 pb-2 pt-1.5">
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {viewer.email}
              </p>
            </div>
            {LINKS.map(({ tab, testId }) => (
              <Menu.Item
                key={tab}
                className={itemClass}
                data-testid={testId}
                onClick={() => {
                  openAccount(tab);
                }}
              >
                <span className="flex-1">{t(`userMenu.${tab}`)}</span>
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-menu-separator" />
            <Menu.Item
              className={itemClass}
              closeOnClick={false}
              data-testid="switch-theme"
              onClick={() => {
                setTheme(nextTheme(theme));
              }}
            >
              <span className="flex-1">{t("userMenu.switchTheme")}</span>
            </Menu.Item>
            <Menu.Item
              className={itemClass}
              data-testid="sign-out"
              closeOnClick={false}
              onClick={() => void signOut()}
            >
              <span className="flex-1">
                {signingOut ? t("userMenu.signingOut") : t("userMenu.signOut")}
                {/* Inside the item, not beside it: `role="menu"` may contain
                    only menuitems, groups and separators, so a sibling
                    paragraph here is an aria-required-children violation (the
                    axe sweep in shell-client.test.tsx caught exactly that).
                    The announcement is made by the live region outside the
                    menu below, which is where a role that does not belong in a
                    menu can live. */}
                {signOutFailed ? (
                  <span
                    data-testid="sign-out-failed"
                    className="mt-0.5 block text-xs text-destructive"
                  >
                    {t("userMenu.signOutFailed")}
                  </span>
                ) : null}
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
      {/* Outside the popup, so the menu keeps only the children its role
          allows, and assertive because the person believes they have just
          signed out on a machine they may not trust. */}
      <p role="alert" aria-live="assertive" className="sr-only">
        {signOutFailed ? t("userMenu.signOutFailed") : ""}
      </p>
    </Menu.Root>
  );
}
