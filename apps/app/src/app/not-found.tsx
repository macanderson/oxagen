import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <Link href="/" className="underline">
        {t("home")}
      </Link>
    </main>
  );
}
