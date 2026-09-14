"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxPopup,
  ComboboxItem,
} from "@/components/ui/combobox";
import { AvatarUpload } from "@/components/media/avatar-upload";
import { slugify } from "@/lib/slug";
import type { OrgSignupPrefill } from "@/lib/oauth-prefill";
import {
  ORG_TYPE_OPTIONS,
  INDUSTRY_OPTIONS,
  EMPLOYEE_SIZE_OPTIONS,
} from "@oxagen/config";
import type { OrgType } from "@oxagen/config";

export interface NewOrgAction {
  (
    formData: FormData,
  ): Promise<
    | { ok: true; orgSlug: string; workspaceSlug: string }
    | { ok: false; error: string }
  >;
}

// Slug rules mirror the organization.create contract pattern: [a-z0-9-]{2,40}.
function deriveSlug(name: string): string {
  return slugify(name).slice(0, 40);
}

const PROVIDER_LABEL: Record<
  NonNullable<OrgSignupPrefill["provider"]>,
  string
> = {
  google: "Google",
  github: "GitHub",
};

export function NewOrgForm({
  action,
  prefill,
}: {
  action: NewOrgAction;
  prefill?: OrgSignupPrefill;
}) {
  // The default account type drives which name the form seeds: a business org
  // name (derived from the email domain) for "business", the user's own name
  // for "personal".
  const suggestedName = React.useCallback(
    (type: OrgType): string =>
      type === "business"
        ? (prefill?.suggestedBusinessName ?? "")
        : (prefill?.name ?? ""),
    [prefill],
  );

  const [pending, startTransition] = React.useTransition();
  // Stays true from action success until the full-page navigation completes.
  // Without it the button re-enables in the window between the transition
  // ending and window.location.assign() unloading the page — a duplicate click
  // there re-submits the already-created slug and surfaces "already taken".
  const [navigating, setNavigating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [orgType, setOrgType] = React.useState<OrgType>("business");
  const [name, setName] = React.useState(() => suggestedName("business"));
  const [slug, setSlug] = React.useState(() =>
    deriveSlug(suggestedName("business")),
  );
  const [industry, setIndustry] = React.useState("");
  const [employeeSize, setEmployeeSize] = React.useState("");
  // Logo is optional at creation; AvatarUpload.onChange returns the uploaded
  // blob URL, mirrored into a hidden input so it rides the FormData submit.
  // Seeded with the OAuth avatar (an external Google/GitHub URL) — the server
  // action copies that into our blob store on submit.
  const [avatarUrl, setAvatarUrl] = React.useState(prefill?.avatarUrl ?? "");
  // The slug auto-follows the name until the user hand-edits it to a non-empty
  // value. Clearing the slug field back to empty re-arms auto-population, so an
  // empty slug + a name change always repopulates the slug.
  const slugManuallyEdited = React.useRef(false);
  // The name auto-follows the account-type toggle until the user hand-edits it,
  // so flipping personal⇄business swaps the prefilled name appropriately.
  const nameManuallyEdited = React.useRef(false);

  const isBusiness = orgType === "business";

  // Switch account type and, when the user hasn't overridden the name, re-seed
  // the name (and dependent slug) from the prefill for the new type.
  const selectOrgType = (next: OrgType) => {
    setOrgType(next);
    if (!nameManuallyEdited.current) {
      const seeded = suggestedName(next);
      setName(seeded);
      if (!slugManuallyEdited.current) setSlug(deriveSlug(seeded));
    }
  };

  const providerLabel = prefill?.provider
    ? PROVIDER_LABEL[prefill.provider]
    : null;

  const onSubmit = (e: {
    preventDefault(): void;
    currentTarget: HTMLFormElement;
  }) => {
    e.preventDefault();
    if (pending || navigating) return;
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      // A rejected server action (dropped connection, deploy mid-submit, an
      // unhandled throw) must not become a silent unhandled rejection that
      // re-enables the button with no explanation — the user would click again
      // and hit "slug already taken" on a half-created org. Surface it.
      const res = await action(fd).catch(() => null);
      if (res === null) {
        setError("Could not create the organization. Please try again.");
        return;
      }
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNavigating(true);
      // Hard navigation into the freshly-created tenant — NOT router.push +
      // router.refresh(). Issuing both inside one transition races the soft
      // navigation against a cache-busting refresh of the *current* tree and
      // hangs the transition (the button sticks on "Creating…" and the URL
      // never commits, even though the org was created). A full-page assign
      // renders the new org/workspace tree from scratch on the server, so the
      // org appears in the switcher with no stale App Router cache and no race.
      // This path runs once per org create, so the full reload cost is moot.
      window.location.assign(`/${res.orgSlug}/${res.workspaceSlug}`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {/* Attribution — only when the profile came from a social provider, so
          the user knows the fields were prefilled and are theirs to edit. */}
      {providerLabel && (
        <p className="text-xs text-muted-foreground">
          Prefilled from your {providerLabel} account — edit anything below.
        </p>
      )}

      {/* ── Type selector ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label>Account type</Label>
        <div className="flex rounded-md border border-input overflow-hidden">
          {ORG_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => selectOrgType(opt.value)}
              className={[
                "flex-1 px-4 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                orgType === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
              ].join(" ")}
              aria-pressed={orgType === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Submit the type discriminator via FormData */}
        <input type="hidden" name="type" value={orgType} />
      </div>

      {/* Single-column body: identity + business fields. (Billing email/address
          were removed with billing.org_billing_profiles — Stripe collects the
          billing address at checkout.) */}
      <div className="flex flex-col gap-4">
        {/* ── Name ─────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <Label htmlFor="name">
            {isBusiness ? "Organization name" : "Your name"}
          </Label>
          <Input
            id="name"
            name="name"
            required
            maxLength={120}
            placeholder={isBusiness ? "Acme Inc." : "Jane Smith"}
            value={name}
            onChange={(e) => {
              const next = e.target.value;
              // A hand-edit pins the name so the account-type toggle stops
              // re-seeding it from the prefill.
              nameManuallyEdited.current = true;
              setName(next);
              // Auto-populate while the user hasn't overridden the slug, and also
              // whenever the slug is currently empty (re-armed override).
              if (!slugManuallyEdited.current || slug === "") {
                slugManuallyEdited.current = false;
                setSlug(deriveSlug(next));
              }
            }}
          />
        </div>

        {/* ── Slug ─────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            name="slug"
            required
            pattern="[a-z0-9\-]{2,40}"
            placeholder={isBusiness ? "acme" : "jane-smith"}
            value={slug}
            onChange={(e) => {
              const next = e.target.value;
              // An empty slug re-arms auto-population; any non-empty edit overrides it.
              slugManuallyEdited.current = next !== "";
              setSlug(next);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, digits, and hyphens. 2 to 40 chars.
          </p>
        </div>

        {/* ── Logo ─────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <Label>
            {isBusiness ? "Logo" : "Photo"}{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </Label>
          <AvatarUpload
            value={avatarUrl || null}
            onChange={setAvatarUrl}
            fallback={name.charAt(0) || slug.charAt(0)}
            shape="square"
            disabled={pending}
          />
          {/* Hidden input carries the uploaded URL into FormData on submit. */}
          <input type="hidden" name="avatarUrl" value={avatarUrl} readOnly />
        </div>

        {/* ── Business-only fields ─────────────────────────────────────── */}
        {isBusiness && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="website">
                Business website{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                id="website"
                name="website"
                type="url"
                placeholder="https://acme.com"
                autoComplete="url"
                // Seeded from the email domain for business (non-consumer) emails.
                defaultValue={prefill?.suggestedWebsite || undefined}
              />
            </div>

            {/* Industry — 24 options: searchable combobox (>20 option rule) */}
            <div className="space-y-1.5">
              <Label htmlFor="industry">
                Industry{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Combobox
                value={industry}
                onValueChange={(v) => setIndustry(v ?? "")}
              >
                <ComboboxTrigger id="industry" size="lg" className="w-full">
                  <ComboboxValue placeholder="Select industry" />
                </ComboboxTrigger>
                <ComboboxPopup searchPlaceholder="Search industries…">
                  {INDUSTRY_OPTIONS.map((opt) => (
                    <ComboboxItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </ComboboxItem>
                  ))}
                </ComboboxPopup>
              </Combobox>
              <input type="hidden" name="industry" value={industry} readOnly />
            </div>

            {/* Team size — 9 options: plain select (≤20 option rule) */}
            <div className="space-y-1.5">
              <Label htmlFor="employeeSize">
                Team size{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Select
                value={employeeSize}
                onValueChange={(v) => setEmployeeSize(v ?? "")}
              >
                <SelectTrigger id="employeeSize" size="lg" className="w-full">
                  <SelectValue placeholder="Select team size" />
                </SelectTrigger>
                <SelectPopup>
                  {EMPLOYEE_SIZE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <input
                type="hidden"
                name="employeeSize"
                value={employeeSize}
                readOnly
              />
            </div>
          </>
        )}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" size="lg" disabled={pending || navigating}>
        {pending || navigating ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
