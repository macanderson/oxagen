// Message catalogs (spec §15 "Language"): ICU MessageFormat, English source, no
// locale routing. Each file under messages/ holds top-level namespaces. `en.json`
// carries the shared ones (app, routes, states); each page lane adds
// messages/<page>.json with its own namespace and appends its stem to
// CATALOG_FILES. No two files may declare the same namespace.

export type Messages = Record<string, unknown>;

export const DEFAULT_LOCALE = "en";

/** Catalog file stems under messages/, merged in this order. */
export const CATALOG_FILES = ["en"] as const;

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
