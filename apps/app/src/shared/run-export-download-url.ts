// A run export's download URL (`get_run_export`; spec §13.4): the external
// target the Run page's export dialog links to. It is served by the API, not
// by this app, so it is not a SafePath. A RunExportDownloadUrl is an absolute
// http(s) URL on the API's download path, with no credentials, written exactly
// as the URL parser writes it back. A relative URL is refused: it would
// resolve against this app's origin, which does not serve the path.

declare const runExportDownloadUrl: unique symbol;
export type RunExportDownloadUrl = string & {
  readonly [runExportDownloadUrl]: true;
};

/** `RUN_EXPORT_DOWNLOAD_PATH` in packages/handlers/src/lib/run-export-download.ts. */
const RUN_EXPORT_DOWNLOAD_PATH = "/v1/run-exports/download";

function isRunExportDownloadUrl(
  raw: string,
  url: URL,
): raw is RunExportDownloadUrl {
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === RUN_EXPORT_DOWNLOAD_PATH &&
    url.searchParams.has("token") &&
    url.href === raw
  );
}

export function parseRunExportDownloadUrl(
  raw: string,
): RunExportDownloadUrl | null {
  if (!URL.canParse(raw)) return null;
  return isRunExportDownloadUrl(raw, new URL(raw)) ? raw : null;
}
