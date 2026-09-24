"use client";
// The SCIM token on Organization › Single sign-on (#3734): generate, rotate,
// and revoke. Generating and rotating answer the token once, so the dialog
// stays open on it with a copy button until the admin dismisses it; the page
// then re-reads and shows only the token's first characters.
import { useTranslations } from "next-intl";
import { useNavigate } from "@/ui/navigation";
import { WriteDialog } from "./dialog";
import {
  createScimToken,
  type MintedScimToken,
  revokeScimToken,
  rotateScimToken,
} from "./sso-actions";
import { CopyValue } from "./sso-controls";

function MintedToken({ minted }: { minted: MintedScimToken }) {
  const t = useTranslations("organization.sso.scim");
  return (
    <div className="flex flex-col gap-3" data-testid="scim-token-minted">
      <p className="text-sm font-medium text-foreground">{t("once")}</p>
      <CopyValue
        label={t("tokenLabel")}
        value={minted.token}
        testId="scim-token-value"
      />
      <CopyValue
        label={t("baseUrl")}
        value={minted.baseUrl}
        testId="scim-token-base-url"
      />
    </div>
  );
}

/**
 * Generate when there is no live token, otherwise rotate and revoke. The
 * handlers check the role and the plan again; `entitled` only decides which
 * buttons are worth showing, since revoking stays open after a downgrade.
 */
export function ScimTokenControls({
  org,
  hasToken,
  entitled,
}: {
  org: string;
  hasToken: boolean;
  entitled: boolean;
}) {
  const t = useTranslations("organization.sso.scim");
  const navigate = useNavigate();
  const refresh = () => {
    navigate.refresh();
  };
  const done = {
    close: t("cancel"),
    render: (minted: MintedScimToken) => <MintedToken minted={minted} />,
  };
  return (
    <div className="flex flex-wrap gap-2">
      {entitled && !hasToken ? (
        <WriteDialog
          copy={{
            open: t("generate"),
            title: t("generate"),
            confirm: t("generate"),
            pending: t("pending"),
          }}
          testId="scim-token-generate"
          submit={() => createScimToken(org)}
          onDone={refresh}
          done={done}
        >
          <p className="text-sm text-muted-foreground">{t("once")}</p>
        </WriteDialog>
      ) : null}
      {entitled && hasToken ? (
        <WriteDialog
          copy={{
            open: t("rotate"),
            title: t("rotateTitle"),
            confirm: t("rotate"),
            pending: t("pending"),
          }}
          testId="scim-token-rotate"
          submit={() => rotateScimToken(org)}
          onDone={refresh}
          done={done}
        >
          <p className="text-sm text-muted-foreground">{t("rotateBody")}</p>
        </WriteDialog>
      ) : null}
      {hasToken ? (
        <WriteDialog
          copy={{
            open: t("revoke"),
            title: t("revokeTitle"),
            confirm: t("revoke"),
            pending: t("pending"),
          }}
          testId="scim-token-revoke"
          submit={() => revokeScimToken(org)}
          onDone={refresh}
        >
          <p className="text-sm text-muted-foreground">{t("revokeBody")}</p>
        </WriteDialog>
      ) : null}
    </div>
  );
}
