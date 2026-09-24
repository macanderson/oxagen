import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "@/features/auth";
import { AuthColumn, AuthFooter } from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("forgotPassword") };
}

export default async function ForgotPasswordPage() {
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn>
      <ForgotPasswordForm
        header={
          <PageHeader
            eyebrow={t("forgot.eyebrow")}
            title={pages("forgotPassword")}
            description={t("forgot.lead")}
          />
        }
        footer={
          <AuthFooter>
            <Link href="/login" className={linkText}>
              {t("forgot.back")}
            </Link>
          </AuthFooter>
        }
      />
    </AuthColumn>
  );
}
