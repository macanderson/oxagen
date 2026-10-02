"use client";
// Sign out from a page outside the shell. The steering connect's result page
// (#5151) shows it to a person signed in with an account that can't open the
// organization that started the connect, so they can sign in with one that
// can. It ends the session the way the user menu does: only a sign-out the
// server confirmed leaves for the sign-in page, and a refused one says so and
// stays.
//
// It leaves out the user menu's recovery-code check. That check protects a set
// of codes issued in this page's memory, and the pages that show this button
// are reached by a full redirect from another site, so they hold none.
import { useState } from "react";
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { liveSignOut } from "./session-client";

export function SignOutButton() {
  const t = useTranslations("shell");
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setFailed(false);
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
      navigate.replace(routes.login());
      return;
    }
    setFailed(true);
  }

  return (
    <>
      <button
        type="button"
        data-testid="sign-out-button"
        className={buttonSecondary}
        disabled={signingOut}
        onClick={() => void signOut()}
      >
        {signingOut ? t("userMenu.signingOut") : t("userMenu.signOut")}
      </button>
      <p
        role="alert"
        aria-live="assertive"
        data-testid="sign-out-button-failed"
        className={failed ? "basis-full text-xs text-destructive" : "sr-only"}
      >
        {failed ? t("userMenu.signOutFailed") : ""}
      </p>
    </>
  );
}
