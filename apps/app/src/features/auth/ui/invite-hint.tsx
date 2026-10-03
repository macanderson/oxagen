"use client";
// "Have an invitation? Accept invitation" in the login footer. An invitation opens from
// the link in its email, which carries its token, so Accept invitation says where to
// find that link rather than leading to a page with nothing to accept.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/ui/button";
import { authLinkButton } from "./auth-card";

export function InviteHint() {
  const t = useTranslations("auth.login");
  const [open, setOpen] = useState(false);
  return (
    <>
      {t("haveInvite")}{" "}
      <Button
        type="button"
        variant="link"
        size="xs"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
        }}
        className={`${authLinkButton} h-auto text-base`}
      >
        {t("acceptIt")}
      </Button>
      {open ? (
        <span role="status" className="mt-2 block text-foreground">
          {t("acceptHint")}
        </span>
      ) : null}
    </>
  );
}
