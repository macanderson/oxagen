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
import { BillingAddressFields } from "@/components/billing/billing-address-fields";
import { AvatarUpload } from "@/components/media/avatar-upload";
import { slugify } from "@/lib/slug";
import type { OrgSignupPrefill } from "@/lib/oauth-prefill";
import { ORG_TYPE_OPTIONS, INDUSTRY_OPTIONS, EMPLOYEE_SIZE_OPTIONS } from "@oxagen/config";
import type { OrgType } from "@oxagen/config";

export interface NewOrgAction {
  (formData: FormData): Promise<{ ok: true; orgSlug: string; workspaceSlug: string } | { ok: false; error: string }>;
}

// Slug rules mirror the organization.create contract pattern: [a-z0-9-]{2,40}.
function deriveSlug(name: string): string {
  return slugify(name).slice(0, 40);
}

const PROVIDER_LABEL: Record<NonNullable<OrgSignupPrefill["provider"]>, string> = {
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
  const [error, setError] = React.useState<string | null>(null);
  const [orgType, setOrgType] = React.useState<OrgType>("business");
  const [name, setName] = React.useState(() => suggestedName("business"));
  const [slug, setSlug] = React.useState(() => deriveSlug(suggestedName("business")));
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

  const providerLabel = prefill?.provider ? PROVIDER_LABEL[prefill.provider] : null;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
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

      {/* Two-column body so the form gains horizontal width instead of running
          off the top/bottom of the page: identity + business + billing email on
          the left, billing address on the right. Collapses to one column on
          mobile. */}
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2 md:items-start">
        {/* Left column — identity, business, billing email */}
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
        <p className="text-xs text-muted-foreground">Lowercase letters, digits, and hyphens. 2 to 40 chars.</p>
      </div>

      {/* ── Logo ─────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label>{isBusiness ? "Logo" : "Photo"} <span className="text-muted-foreground font-normal">(optional)</span></Label>
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
            <Label htmlFor="website">Business website <span className="text-muted-foreground font-normal">(optional)</span></Label>
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

          <div className="space-y-1.5">
            <Label htmlFor="industry">Industry <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Select
              value={industry || undefined}
              onValueChange={(v) => setIndustry(v ?? "")}
            >
              <SelectTrigger id="industry" size="lg" className="w-full">
                <SelectValue placeholder="Select industry" />
              </SelectTrigger>
              <SelectPopup>
                {INDUSTRY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <input type="hidden" name="industry" value={industry} readOnly />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="employeeSize">Team size <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Select
              value={employeeSize || undefined}
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
            <input type="hidden" name="employeeSize" value={employeeSize} readOnly />
          </div>
        </>
      )}

      {/* ── Billing email ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label htmlFor="billingEmail">Billing email <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input
          id="billingEmail"
          name="billingEmail"
          type="email"
          placeholder="billing@acme.com"
          autoComplete="email"
          // Seeded with the signed-in user's verified email.
          defaultValue={prefill?.email || undefined}
        />
      </div>
        </div>{/* end left column */}

        {/* Right column — billing address */}
        <BillingAddressFields />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
