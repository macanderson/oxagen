/**
 * The name an organisation's assistant key carries in the OpenRouter account
 * (ADR-131).
 *
 * Pure, and in its own module, because it is the one piece of this feature a
 * person reads directly. An auditor scrolling the vendor's key list, or a
 * finance person matching an OpenRouter invoice line to an Oxagen customer,
 * has this string and nothing else, so it has to answer "whose is this?" on
 * its own.
 *
 *     oxagen/acme-corp/dana@acme.example
 *     └ 1 ─┘└── 2 ───┘└────── 3 ────────┘
 *
 *   1. the product, so a key Oxagen minted is distinguishable from one a
 *      person made by hand in the dashboard;
 *   2. the organisation's slug AS IT WAS AT CREATION;
 *   3. the email of the person who created the organisation — at signup the
 *      person signing up, and otherwise the signed-in person who created it.
 *
 * FIXED AT CREATION, ON PURPOSE. A slug is renameable (`org_slug_history`)
 * and this name is not rewritten when it changes, which means a long-lived
 * organisation's key can name a slug the product no longer answers to. That
 * is the deliberate trade: a name that is rewritten is a name that cannot be
 * read backwards, and reconciling last quarter's invoice needs the label the
 * spend was actually incurred under. The durable identity is not this string
 * at all — it is the key's `hash`, which `org.assistant_model_keys` joins the
 * organisation to. The name is a label for people; the hash is the identity.
 *
 * The email is likewise a point-in-time fact. The creator may leave the
 * organisation; the key stays theirs in the vendor's list because that is who
 * the account was opened by. Neither field is a permission — nothing is
 * authorised by reading this name.
 */

/**
 * A key name is at most this many characters. Well inside anything OpenRouter
 * rejects; the bound exists so a pathological email or slug cannot produce a
 * name that a dashboard column truncates into ambiguity.
 */
export const ASSISTANT_KEY_NAME_MAX = 120;

/** The prefix every Oxagen-minted key carries. */
export const ASSISTANT_KEY_NAME_PREFIX = "oxagen";

export interface AssistantKeyNameArgs {
  /** The organisation's slug at the moment it was created. */
  readonly orgSlug: string;
  /** The email of the person who created the organisation. */
  readonly creatorEmail: string;
}

/**
 * Build the name. Total, never throws: this runs on the organisation-creation
 * path, and a name that cannot be built must not be the reason an
 * organisation fails to get a key.
 *
 * Both fields are sanitised rather than validated. They arrive from columns
 * the product already constrains, but they land in a vendor's UI and in
 * operator log lines, so anything that could break a line or hide characters
 * is removed here rather than trusted upstream: control characters (a
 * newline in a name makes a log entry look like two), the `/` separator
 * itself (so a slug containing one cannot forge a field), and leading or
 * trailing whitespace.
 *
 * An empty field becomes `unknown` rather than collapsing the name into
 * `oxagen//`, which reads as a bug rather than as missing information.
 */
export function assistantKeyName(args: AssistantKeyNameArgs): string {
  const slug = field(args.orgSlug);
  const email = field(args.creatorEmail);
  const name = `${ASSISTANT_KEY_NAME_PREFIX}/${slug}/${email}`;
  return name.length <= ASSISTANT_KEY_NAME_MAX
    ? name
    : // Truncate the email, never the slug: the slug is what an operator
      // searches by, and a half-email still identifies a person within one
      // organisation. The ellipsis marks that something was cut, so nobody
      // reads the result as a whole address.
      `${name.slice(0, ASSISTANT_KEY_NAME_MAX - 1)}…`;
}

function field(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    // Control characters, including the newline that would split a log line.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("/", "-")
    .trim()
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : "unknown";
}
