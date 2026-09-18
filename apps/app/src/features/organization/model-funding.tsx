// Organization › Model funding (ADR-053 §2): whose key pays for the in-app
// assistant's model calls. With no key stored the organisation runs on
// Oxagen's key and the tokens are billed as assistant usage; with a key stored
// the organisation's own vendor bills it directly and Oxagen charges nothing
// for those tokens.
//
// Org-scoped, not workspace-scoped: the key pays for every workspace's turns.
// Owner or Admin only, enforced in all four handlers (INV-29) — a viewer below
// that role is answered `denied` by the read, and this section says so rather
// than showing a form every write of which would be refused.
import { useTranslations } from "next-intl";
import type { ModelCredential } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import { OutcomePanel } from "@/ui/form-feedback";
import { ReadFailure } from "@/ui/read-failure";
import { ModelFundingForm } from "./model-funding-form";
import { OrganizationTabs } from "./tabs";

export async function ModelFunding({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const read = await source.org.modelCredential(ctx);
  return <ModelFundingSection orgSlug={ctx.orgSlug} read={read} />;
}

function ModelFundingSection({
  orgSlug,
  read,
}: {
  orgSlug: string;
  read: Read<ModelCredential>;
}) {
  const t = useTranslations("organization.modelFunding");
  return (
    <div className="flex flex-col gap-6">
      <OrganizationTabs org={orgSlug} current="modelFunding" />
      <p className="max-w-3xl text-sm text-muted-foreground">{t("intro")}</p>
      {read.ok ? (
        <ModelFundingForm org={orgSlug} credential={read.value} />
      ) : read.reason === "denied" ? (
        <OutcomePanel
          tone="deny"
          testId="funding-denied"
          title={t("denied.title")}
        >
          {t("denied.body")}
        </OutcomePanel>
      ) : (
        <ReadFailure read={read} section={t("title")} />
      )}
    </div>
  );
}
