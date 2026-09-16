"use server";
/**
 * preferences-action.ts — server action for the Account Preferences page.
 *
 * Routes writes through the `set_preferences` capability handler; never
 * hand-rolls a direct DB insert. Also sets `pref-font-size` and
 * `pref-density` cookies for flash-free SSR appearance on next load.
 */
import { z } from "zod";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSessionOrRedirect } from "@/lib/session";
import { account } from "@/lib/routes";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("set_preferences", …) can resolve its handler at runtime.
import "@oxagen/handlers/register";
import { logger } from "@oxagen/handlers/logger";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Input schema ─────────────────────────────────────────────────────────────

const PreferencesSchema = z.object({
  fontSize: z.enum(["small", "medium", "large"]),
  density: z.enum(["compact", "comfortable", "spacious"]),
  enterToSubmit: z.boolean(),
  pendingPromptBehavior: z.enum(["queue", "interrupt"]),
  defaultTextTier: z.enum(["fast", "balanced", "precise"]).nullable(),
  defaultTextModel: z.string().min(1).nullable(),
  timezone: z.string().min(1),
  language: z.string().min(2),
});

export type PreferencesInput = z.infer<typeof PreferencesSchema>;

export type PreferencesActionResult =
  | { ok: true }
  | { ok: false; error: string };

// ── Action ───────────────────────────────────────────────────────────────────

export async function updatePreferencesAction(
  input: PreferencesInput,
): Promise<PreferencesActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = PreferencesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid preferences",
    };
  }

  const data = parsed.data;

  // Build a minimal user-scoped CapabilityContext. Preferences are user-scoped
  // (scoped: false on the contract), so orgId / workspaceId are sentinel values.
  const ctx: CapabilityContext = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  try {
    // `set_preferences` is the one writer of the preference row (ADR-069). Its
    // `locale` is the row's `language` column, which is the name this form and
    // `get_user_preferences` use; the rest carry across unchanged.
    //
    // No `surface` override: the contract's allowlist is ["api", "mcp"] and
    // this is neither. Naming a surface the call did not arrive on to satisfy
    // the allowlist would file every preference write from this page under
    // traffic that never happened. `ctx.surface` already records "app", which
    // is what the kernel's own event carries.
    const { language, ...rest } = data;
    await invoke("set_preferences", { ...rest, locale: language }, ctx);
  } catch (err) {
    // Log before returning the generic message: without this the only trace of
    // a failed preference write is a toast on the user's screen.
    logger.error(
      { err, userId: session.user.id },
      "[account-preferences] set_preferences failed",
    );
    return {
      ok: false,
      error: "Failed to save preferences. Please try again.",
    };
  }

  // Set appearance cookies so the next SSR render picks up the new values
  // flash-free (the root layout reads these and writes them as data-* attributes
  // on <html> before the page is streamed to the client).
  const cookieStore = await cookies();
  cookieStore.set("pref-font-size", data.fontSize, {
    path: "/",
    httpOnly: false, // readable by client JS (dataset sync on optimistic update)
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  cookieStore.set("pref-density", data.density, {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath(account.preferences());
  revalidatePath(account.root());

  return { ok: true };
}
