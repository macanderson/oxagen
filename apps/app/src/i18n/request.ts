import { getRequestConfig } from "next-intl/server";
import {
  CATALOG_FILES,
  DEFAULT_LOCALE,
  type Messages,
  mergeCatalogs,
} from "./catalogs";

async function loadCatalog(file: string): Promise<readonly [string, Messages]> {
  const mod = (await import(`../../messages/${file}.json`)) as {
    default: Messages;
  };
  return [file, mod.default];
}

export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: mergeCatalogs(await Promise.all(CATALOG_FILES.map(loadCatalog))),
}));
