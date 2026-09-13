// The non-loaded states of a page, driven by a port's `Read<T>` result
// (plan §4.8). Batch 1 lane L2 grows this into the full set (skeleton, empty,
// error, denied, not recorded yet) with per-page error codes; the contract stays:
// pass the failed read, never invent a zero.
import { getTranslations } from "next-intl/server";
import type { ReadFailure } from "@/data/not-backed";

export type PageStateProps = { page: string } & (
  | { result: ReadFailure }
  | { empty: true }
);

export async function PageState(props: PageStateProps) {
  const t = await getTranslations("states");
  if ("empty" in props) {
    return (
      <section
        aria-labelledby={`page-state-${props.page}-empty`}
        data-testid="page-state-empty"
      >
        <h2 id={`page-state-${props.page}-empty`}>{t("empty.title")}</h2>
      </section>
    );
  }
  const r = props.result;
  const titleId = `page-state-${props.page}-${r.reason}`;
  let title: string;
  let body: string;
  switch (r.reason) {
    case "not_backed":
      title = t("notBacked.title");
      body = t("notBacked.body", { milestone: r.milestone, gap: r.gap });
      break;
    case "denied":
      title = t("denied.title");
      body = t("denied.body", { permission: r.permission });
      break;
    case "error":
      title = t("error.title");
      body = t("error.body", { code: r.code, status: r.status });
      break;
  }
  return (
    <section
      aria-labelledby={titleId}
      data-testid={`page-state-${r.reason}`}
      className="flex flex-col gap-2 py-6"
    >
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      <p className="text-muted-foreground">{body}</p>
    </section>
  );
}
