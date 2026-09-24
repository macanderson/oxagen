"use client";
// "Signed in as <name>. The session is recorded like any other governed
// action." (mockups `obSignedIn`), shown once on the first shell page a
// sign-in lands on. The sign-in forms leave the mark (auth-client.ts); this
// reads it after hydration, so a reload or a later page shows nothing. The
// claim holds because Better Auth writes auth.sign_in for every new session
// (packages/auth/src/auth.ts, session.create.after). The row rides the app's
// one toast stack (@/ui/toast), which removes it after TOAST_MS.
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { ToastStack, useToasts } from "@/ui/toast";
import { takeSignedIn } from "../auth-client";

export function SignedInToast({ name }: { name: string }) {
  const t = useTranslations("auth");
  const { toasts, toast } = useToasts();
  // The ref keeps a development double-run from taking the mark twice.
  const tookRef = useRef(false);
  useEffect(() => {
    if (tookRef.current) return;
    tookRef.current = true;
    if (takeSignedIn()) toast(t("signedIn", { name }), "allowed");
  }, [name, t, toast]);
  return <ToastStack toasts={toasts} testId="signed-in-toast" />;
}
