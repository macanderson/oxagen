"use client";
// The two fields every create-workspace form carries for the new workspace's
// steering repo (#5196): the GitHub organization or GitLab group it goes in,
// and its name. The provisioning card reuses them when setup stopped on the
// name or the place before Oxagen created anything.
//
// The places load when the fields mount, through the form's own read of
// `list_steering_repo_destinations`, so in the Organization page's dialog they
// load when it opens. The select starts on the organization's default, or on
// the first place when there is none. With no place connected, or a read that
// failed, there is no select and the form sends no place, so the job uses the
// organization's default.
//
// The name shows `defaultName` until the person types their own, so in a
// create form it follows the workspace name as `oxagen-<slug>`. A field the
// person emptied shows the default as its placeholder and sends no name, so
// the job takes the default. A name the contract would refuse is named under
// the field and marks the input invalid, so the form's own validity check
// stops the submit.
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { inputBase } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import {
  CONNECTION_FIELD,
  connectionValue,
  isRepoNameValid,
  REPO_NAME_FIELD,
  type SteeringRepoDestination,
  type SteeringRepoDestinations,
} from "./destination";

/** The form's read of the places, a server action bound to the viewer's org. */
export type LoadDestinations = (
  org: string,
) => Promise<ActionResult<SteeringRepoDestinations>>;

type PlacesRead =
  | { kind: "loading" }
  | { kind: "ok"; value: SteeringRepoDestinations }
  | { kind: "failed"; code: string };

/** The code a refused or thrown read names. */
function failureCode(
  answer: Extract<ActionResult<unknown>, { ok: false }>,
): string {
  return "code" in answer ? answer.code : answer.reason;
}

function hostName(provider: SteeringRepoDestination["provider"]): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

export function SteeringRepoDestinationFields({
  org,
  load,
  defaultName,
  idPrefix,
  nameError,
  places: withPlaces = true,
}: {
  org: string;
  load: LoadDestinations;
  /**
   * What the name field shows until the person types: `defaultRepoName` of
   * the workspace name in a create form, or the name a stopped setup tried.
   */
  defaultName: string;
  /** Prefixes every element id and test id, such as `create-workspace`. */
  idPrefix: string;
  /** A refusal the server named for the repository name, already translated. */
  nameError?: string | undefined;
  /** False draws the name field alone and reads no places. */
  places?: boolean;
}) {
  const t = useTranslations("repositories.steeringRepo.destination");
  const [places, setPlaces] = useState<PlacesRead>({ kind: "loading" });
  // The person's own name, or null while the field shows `defaultName`.
  const [ownName, setOwnName] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!withPlaces) return;
    let live = true;
    load(org).then(
      (answer) => {
        if (!live) return;
        setPlaces(
          answer.ok
            ? { kind: "ok", value: answer.value }
            : { kind: "failed", code: failureCode(answer) },
        );
      },
      () => {
        if (live) setPlaces({ kind: "failed", code: "action_failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [load, org, withPlaces]);

  const repoName = ownName ?? defaultName;
  const invalid = repoName !== "" && !isRepoNameValid(repoName);
  const nameMessage = invalid ? t("repoNameInvalid") : nameError;
  const nameId = `${idPrefix}-steering-repo-name`;

  // The input's own validity carries the refusal, so a form that submits
  // natively (the Organization page's dialog) stops, and one that reads
  // `repoNameAccepted` (onboarding, the provisioning card) stops too.
  useEffect(() => {
    const input = document.getElementById(nameId);
    if (input instanceof HTMLInputElement)
      input.setCustomValidity(invalid ? t("repoNameInvalid") : "");
  }, [nameId, invalid, t]);

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid={`${idPrefix}-steering-repo`}
    >
      {withPlaces ? (
        <PlaceSelect
          places={places}
          picked={picked}
          onPick={setPicked}
          idPrefix={idPrefix}
        />
      ) : null}
      <Field
        id={nameId}
        name={REPO_NAME_FIELD}
        type="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        label={t("repoName")}
        hint={t("repoNameHint")}
        value={repoName}
        placeholder={defaultName}
        onChange={(event) => {
          setOwnName(event.target.value);
        }}
        error={nameMessage}
        data-testid={nameId}
        className="max-md:text-base"
      />
    </div>
  );
}

function PlaceSelect({
  places,
  picked,
  onPick,
  idPrefix,
}: {
  places: PlacesRead;
  picked: string | null;
  onPick: (value: string) => void;
  idPrefix: string;
}) {
  const t = useTranslations("repositories.steeringRepo.destination");
  const selectId = `${idPrefix}-steering-connection`;
  const label = (
    <label htmlFor={selectId} className="text-sm font-medium text-foreground">
      {t("organization")}
    </label>
  );

  if (places.kind === "loading")
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {label}
        <select
          id={selectId}
          disabled
          aria-busy="true"
          className={inputBase}
          data-testid={`${selectId}-loading`}
        >
          <option>{t("loading")}</option>
        </select>
      </div>
    );

  if (places.kind === "failed")
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid={`${selectId}-failed`}
      >
        {t("failed", { code: places.code })}
      </p>
    );

  const { destinations, reauthorize } = places.value;
  const fallback = places.value.default;
  const notes = (
    <>
      {reauthorize.includes("github") ? (
        <p className="text-sm text-muted-foreground">
          {t("reauthorizeGithub")}
        </p>
      ) : null}
      {reauthorize.includes("gitlab") ? (
        <p className="text-sm text-muted-foreground">
          {t("reauthorizeGitlab")}
        </p>
      ) : null}
    </>
  );

  if (destinations.length === 0)
    return (
      <div
        className="flex min-w-0 flex-col gap-1.5"
        data-testid={`${selectId}-none`}
      >
        <p className="text-sm text-muted-foreground">{t("none")}</p>
        {notes}
      </div>
    );

  const values = destinations.map(connectionValue);
  const preferred =
    fallback !== null && values.includes(connectionValue(fallback))
      ? connectionValue(fallback)
      : (values[0] ?? "");
  const selected =
    picked !== null && values.includes(picked) ? picked : preferred;
  const mixed = new Set(destinations.map((place) => place.provider)).size > 1;
  const optionLabel = (place: SteeringRepoDestination) => {
    const personal = place.kind === "user";
    if (mixed)
      return personal
        ? t("optionHostPersonal", {
            name: place.name,
            host: hostName(place.provider),
          })
        : t("optionHost", { name: place.name, host: hostName(place.provider) });
    return personal ? t("optionPersonal", { name: place.name }) : place.name;
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label}
      <select
        id={selectId}
        name={CONNECTION_FIELD}
        value={selected}
        onChange={(event) => {
          onPick(event.target.value);
        }}
        className={inputBase}
        data-testid={selectId}
      >
        {destinations.map((place) => (
          <option key={connectionValue(place)} value={connectionValue(place)}>
            {optionLabel(place)}
          </option>
        ))}
      </select>
      {notes}
    </div>
  );
}
