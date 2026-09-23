"use client";
// "Signed in as <name>. The session is recorded like any other governed
// action." (mockups `obSignedIn`), shown once on the first shell page a
// sign-in lands on. The sign-in forms leave the mark (auth-client.ts); this
// reads it after hydration, so a reload or a later page shows nothing. The
// claim holds because Better Auth writes auth.sign_in for every new session
// (packages/auth/src/auth.ts, session.create.after).
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Toast, ToastRegion } from "@/ui/toast";
import { takeSignedIn } from "../auth-client";

/** How long the toast stays, as in the design. */
export const SIGNED_IN_TOAST_MS = 4200;

export function SignedInToast({ name }: { name: string }) {
  const t = useTranslations("auth");
  const [shown, setShown] = useState(false);
  // The ref keeps a development double-run from taking the mark twice.
  const took = useRef(false);
  useEffect(() => {
    if (took.current) return;
    took.current = true;
    if (takeSignedIn()) setShown(true);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => {
      setShown(false);
    }, SIGNED_IN_TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [shown]);
  return (
    <ToastRegion>
      {shown ? (
        <Toast testId="signed-in-toast">{t("signedIn", { name })}</Toast>
      ) : null}
    </ToastRegion>
  );
}
