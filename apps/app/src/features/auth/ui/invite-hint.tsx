"use client";
// "Have an invitation? Accept it" in the login footer. An invitation opens from
// the link in its email, which carries its token, so Accept it says where to
// find that link rather than leading to a page with nothing to accept.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { authLinkButton } from "./auth-card";

export function InviteHint() {
  const t = useTranslations("auth.login");
  const [open, setOpen] = useState(false);
  return (
    <>
      {t("haveInvite")}{" "}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
        }}
        className={authLinkButton}
      >
        {t("acceptIt")}
      </button>
      {open ? (
        <span role="status" className="mt-2 block text-foreground">
          {t("acceptHint")}
        </span>
      ) : null}
    </>
  );
}
