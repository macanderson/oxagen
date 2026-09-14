// Batch 0 route skeleton frame: a titled <main> landmark. Each page lane replaces
// its route's use of this with the real page.
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import type en from "../../messages/en.json";

export type RouteKey = Exclude<keyof (typeof en)["routes"], "placeholder">;

export async function PlaceholderPage({
  route,
  children,
}: {
  route: RouteKey;
  children?: ReactNode;
}) {
  const t = await getTranslations("routes");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10"
    >
      <h1 className="text-2xl font-semibold">{t(`${route}.title`)}</h1>
      {children ?? <p className="text-muted-foreground">{t("placeholder")}</p>}
    </main>
  );
}
