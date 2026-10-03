"use client";
// The Slack writes on Organization › Notifications (#4608).
//
// Connect Slack sends the browser to Slack, and the OAuth callback brings it
// back to this tab with the outcome on the URL. Pick a channel reads the
// channels only when it opens, because each read is a call to Slack. Save
// makes the picked channel the one notices post to. Disconnect asks once, in
// the page rather than a browser `confirm()`, before it deletes the token.
//
// After a Save or a Disconnect the tab is read again at its plain URL, so an
// outcome the callback left on the URL does not outlive the change after it.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { SlackChannel, SlackChannelList } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import { inputBase } from "@/ui/control-styles";
import { Button } from "@/ui/button";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { recordReceipt } from "./receipt";
import {
  disconnectSlack,
  listSlackChannels,
  setSlackChannel,
  startSlackConnection,
} from "./slack-actions";
import { UNANSWERED, useSlackFailure } from "./slack-failure";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

type Busy = "idle" | "connecting" | "loading" | "saving" | "disconnecting";

export function NotificationsControls({
  org,
  connected,
  channel,
}: {
  org: string;
  connected: boolean;
  /** The channel notices post to now, or null when none is picked. */
  channel: SlackChannel | null;
}) {
  const t = useTranslations("organization.notifications");
  const tReceipt = useTranslations("organization.receipts");
  const failureText = useSlackFailure();
  const navigate = useNavigate();

  const [busy, setBusy] = useState<Busy>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [list, setList] = useState<SlackChannelList | null>(null);
  const [picked, setPicked] = useState("");
  const [confirming, setConfirming] = useState(false);

  async function run<T>(
    kind: Busy,
    write: () => Promise<ActionResult<T>>,
    onOk: (value: T) => void,
  ) {
    if (busy !== "idle") return;
    setBusy(kind);
    setFailure(null);
    try {
      const result = await write();
      if (result.ok) onOk(result.value);
      else setFailure(result);
    } catch {
      setFailure(UNANSWERED);
    } finally {
      setBusy("idle");
    }
  }

  const onConnect = async () => {
    if (busy !== "idle") return;
    setBusy("connecting");
    setFailure(null);
    try {
      // A connection that starts leaves the page for Slack and answers
      // nothing, so the button keeps its busy label until the page goes.
      // The action's type says it always answers, but a redirect answers
      // nothing at run time, so the result is read as possibly undefined.
      const started: Promise<ActionResult<never> | undefined> =
        startSlackConnection(org);
      const result = await started;
      if (result && !result.ok) {
        setFailure(result);
        setBusy("idle");
      }
    } catch {
      setFailure(UNANSWERED);
      setBusy("idle");
    }
  };

  const onOpenPicker = () => {
    void run(
      "loading",
      () => listSlackChannels(org),
      (value) => {
        setList(value);
        setPicked(channel?.channelRef ?? "");
      },
    );
  };

  const onSave = (event: SyntheticEvent) => {
    event.preventDefault();
    if (picked === "") return;
    const name =
      list?.channels.find((c) => c.channelRef === picked)?.name ?? picked;
    void run(
      "saving",
      () => setSlackChannel(org, picked),
      () => {
        setList(null);
        recordReceipt(tReceipt("slackChannelSaved", { name }));
        navigate.replace(routes.notifications(org));
      },
    );
  };

  const onDisconnect = () => {
    void run(
      "disconnecting",
      () => disconnectSlack(org),
      () => {
        setConfirming(false);
        recordReceipt(tReceipt("slackDisconnected"));
        navigate.replace(routes.notifications(org));
      },
    );
  };

  const alert = failure ? (
    <FormAlert testId="slack-failure">{failureText(failure)}</FormAlert>
  ) : null;

  if (!connected)
    return (
      <div className="flex flex-col gap-3">
        {alert}
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void onConnect();
            }}
            aria-disabled={busy !== "idle" || undefined}
            data-testid="slack-connect"
          >
            {busy === "connecting" ? t("connecting") : t("connect")}
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      {list === null ? null : (
        <form
          className="flex flex-col gap-3"
          onSubmit={onSave}
          noValidate
          data-testid="slack-picker"
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="slack-channel"
              className="text-base font-medium text-foreground"
            >
              {t("picker.label")}
            </label>
            <select
              id="slack-channel"
              name="channelRef"
              className={inputBase}
              value={picked}
              onChange={(e) => {
                setPicked(e.target.value);
              }}
            >
              <option value="" disabled>
                {t("picker.placeholder")}
              </option>
              {list.channels.map((c) => (
                <option key={c.channelRef} value={c.channelRef}>
                  {t(c.isPrivate ? "channelNamePrivate" : "channelName", {
                    name: c.name,
                  })}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">
              {t("picker.invite")}
            </p>
          </div>
          {list.channels.length === 0 ? (
            <p className="text-base" data-testid="slack-picker-empty">
              {t("picker.empty")}
            </p>
          ) : null}
          {list.truncated ? (
            <p className="text-base" data-testid="slack-picker-truncated">
              {t("picker.truncated")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton
              pending={busy === "saving"}
              label={t("picker.save")}
              pendingLabel={t("picker.saving")}
              fullWidth={false}
              secondary
              disabled={picked === ""}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setList(null);
                setFailure(null);
              }}
            >
              {t("picker.cancel")}
            </Button>
          </div>
        </form>
      )}
      {alert}
      <div className="flex flex-wrap items-center gap-3">
        {list === null ? (
          <Button
            type="button"
            variant="outline"
            onClick={onOpenPicker}
            aria-disabled={busy !== "idle" || undefined}
            data-testid="slack-pick"
          >
            {busy === "loading"
              ? t("picker.loading")
              : channel === null
                ? t("picker.open")
                : t("picker.change")}
          </Button>
        ) : null}
        {confirming ? (
          <div
            className="flex flex-wrap items-center gap-3"
            data-testid="slack-disconnect-confirm"
          >
            <p className="text-base">{t("disconnect.confirm")}</p>
            <Button
              type="button"
              variant="outline"
              onClick={onDisconnect}
              aria-disabled={busy !== "idle" || undefined}
            >
              {busy === "disconnecting"
                ? t("disconnect.pending")
                : t("disconnect.yes")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("disconnect.cancel")}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setConfirming(true);
            }}
            data-testid="slack-disconnect"
          >
            {t("disconnect.open")}
          </Button>
        )}
      </div>
    </div>
  );
}
