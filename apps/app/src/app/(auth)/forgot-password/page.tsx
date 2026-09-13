import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  ForgotPasswordForm,
  linkText,
} from "@/features/auth";

export default async function ForgotPasswordPage() {
  const t = await getTranslations("auth");
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("forgot.eyebrow")}
        title={t("forgot.title")}
        lead={t("forgot.lead")}
      />
      <ForgotPasswordForm />
      <AuthFooter>
        <Link href="/login" className={linkText}>
          {t("forgot.back")}
        </Link>
      </AuthFooter>
    </AuthColumn>
  );
}
