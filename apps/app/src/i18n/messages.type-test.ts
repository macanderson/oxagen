// INV-12, the compile-time half (ARCHITECTURE.md §4). Compiled by the app's
// `tsc --noEmit`, never executed: each directive below must meet an error, or
// TS2578 fails the typecheck, so they hold only while src/i18n/messages.d.ts
// types every t() key and namespace from messages/*.json.
import { getTranslations } from "next-intl/server";

export async function probe(): Promise<string> {
  const t = await getTranslations("app");
  // @ts-expect-error -- missing.key is in no catalog
  t("missing.key");
  // @ts-expect-error -- no catalog declares the namespace
  await getTranslations("missing");
  // The one positive: a key the shared catalog holds.
  return t("name");
}
