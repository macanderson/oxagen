// Message catalogs (spec §15 "Language"): ICU MessageFormat, English source, no
// locale routing. Each JSON file directly under messages/ holds top-level
// namespaces. `en.json` carries the shared ones (app, routes, states); each page
// lane adds messages/<page>.json with its own namespace and nothing else. The
// directory is the list: no shared array names the files, so two lanes adding
// catalogs never edit the same line. No two files may declare one namespace.

export type Messages = Record<string, unknown>;

export const DEFAULT_LOCALE = "en";

/** The shared catalog. It must exist, and it merges first. */
export const SHARED_CATALOG = "en";

/** A catalog stem is kebab-case, matching the page folder that owns it. */
const STEM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class DuplicateNamespaceError extends Error {
  readonly code = "i18n_duplicate_namespace";

  constructor(
    readonly namespace: string,
    readonly files: readonly [string, string],
  ) {
    super(
      `message namespace "${namespace}" is declared by both messages/${files[0]}.json and messages/${files[1]}.json`,
    );
    this.name = "DuplicateNamespaceError";
  }
}

export class CatalogError extends Error {
  readonly code = "i18n_catalog_invalid";

  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(`messages/${file}: ${reason}`);
    this.name = "CatalogError";
  }
}

/**
 * Turn a directory listing of messages/ into catalog stems, shared catalog
 * first and the rest in code-point order, so the merge (and any
 * DuplicateNamespaceError it raises) does not depend on the filesystem's
 * listing order. Entries that are not `.json` are ignored; a `.json` file with a
 * name that is not a kebab-case stem is refused rather than silently skipped,
 * since a skipped catalog renders as missing strings far from the cause.
 */
export function catalogStems(entries: readonly string[]): string[] {
  const stems: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -".json".length);
    if (!STEM.test(stem))
      throw new CatalogError(
        entry,
        "a catalog file name must be a kebab-case stem, e.g. fleet.json or api-keys.json",
      );
    stems.push(stem);
  }
  if (!stems.includes(SHARED_CATALOG))
    throw new CatalogError(
      `${SHARED_CATALOG}.json`,
      "the shared catalog is missing",
    );
  // Default sort compares UTF-16 code units: locale-independent, and stems are ASCII.
  const rest = stems.filter((stem) => stem !== SHARED_CATALOG).sort();
  return [SHARED_CATALOG, ...rest];
}

/** Parse one catalog's text. A catalog is a JSON object of namespaces. */
export function parseCatalog(stem: string, text: string): Messages {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // JSON.parse throws nothing but SyntaxError.
    throw new CatalogError(
      `${stem}.json`,
      `not valid JSON (${(error as SyntaxError).message})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CatalogError(
      `${stem}.json`,
      "a catalog must be a JSON object of namespaces",
    );
  return parsed as Messages;
}

/** Merge catalogs by top-level namespace. A namespace claimed twice is a lane collision, so it throws. */
export function mergeCatalogs(
  catalogs: ReadonlyArray<readonly [file: string, messages: Messages]>,
): Messages {
  const merged: Messages = {};
  const owner = new Map<string, string>();
  for (const [file, messages] of catalogs) {
    for (const [namespace, value] of Object.entries(messages)) {
      const previous = owner.get(namespace);
      if (previous !== undefined)
        throw new DuplicateNamespaceError(namespace, [previous, file]);
      owner.set(namespace, file);
      merged[namespace] = value;
    }
  }
  return merged;
}
