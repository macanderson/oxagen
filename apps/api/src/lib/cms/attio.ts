/**
 * Minimal Attio REST client for the website lead sync.
 *
 * Three calls, all idempotent from the caller's point of view: people and
 * companies are asserted by their one unique attribute (`email_addresses`
 * and `domains`), so a retry after a lost response updates the same record
 * instead of creating a second one. Notes are the exception (a note is a
 * new object every time), so the sync writes one only after the record
 * asserts succeed.
 *
 * Transient failures (429 and 5xx) are retried with backoff, honouring
 * `Retry-After`. Anything else is an `AttioRequestError` carrying the status
 * and the response body, which the sync records on the lead row.
 *
 * API reference: https://docs.attio.com/rest-api/endpoint-reference
 */

export const ATTIO_BASE_URL = "https://api.attio.com/v2";

export class AttioRequestError extends Error {
  readonly code = "attio_request_failed";
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Attio ${path} answered ${status}: ${body.slice(0, 300)}`);
    this.name = "AttioRequestError";
  }
}

export interface AttioPersonInput {
  email: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  /** E.164 only (`+15558675309`); anything else is dropped by the caller. */
  phone?: string | null;
  /** Attio record id of the company to link, from `assertCompany`. */
  companyRecordId?: string | null;
}

export interface AttioCompanyInput {
  domain: string;
  name: string;
}

export interface AttioNoteInput {
  parentObject: "people" | "companies";
  parentRecordId: string;
  title: string;
  content: string;
}

export interface AttioClient {
  assertPerson(input: AttioPersonInput): Promise<{ recordId: string }>;
  assertCompany(input: AttioCompanyInput): Promise<{ recordId: string }>;
  createNote(input: AttioNoteInput): Promise<{ noteId: string }>;
}

export interface AttioClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Attempts per call, including the first. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms; doubles per attempt. Default 250. */
  backoffMs?: number;
  /** Injected for tests so retries do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface RecordResponse {
  data?: { id?: { record_id?: string } };
}

interface NoteResponse {
  data?: { id?: { note_id?: string } };
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function createAttioClient(opts: AttioClientOptions): AttioClient {
  const baseUrl = (opts.baseUrl ?? ATTIO_BASE_URL).replace(/\/$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 250;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function request<T>(
    method: "PUT" | "POST",
    path: string,
    body: unknown,
  ): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network failure: retry like a 5xx.
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }
      if (res.ok) {
        return (await res.json()) as T;
      }
      const text = await res.text();
      lastError = new AttioRequestError(res.status, path, text);
      if (RETRYABLE(res.status) && attempt < maxAttempts) {
        await sleep(retryAfterMs(res) ?? backoffMs * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }
    // Unreachable: every loop exit above returns or throws.
    throw lastError ?? new Error("Attio request failed");
  }

  function recordId(path: string, res: RecordResponse): string {
    const id = res.data?.id?.record_id;
    if (!id) {
      throw new AttioRequestError(200, path, "response carried no record_id");
    }
    return id;
  }

  return {
    async assertPerson(input) {
      const path = "/objects/people/records?matching_attribute=email_addresses";
      const values: Record<string, unknown> = {
        email_addresses: [{ email_address: input.email }],
        name: [
          {
            first_name: input.firstName,
            last_name: input.lastName,
            full_name: `${input.firstName} ${input.lastName}`.trim(),
          },
        ],
      };
      if (input.jobTitle) values.job_title = [{ value: input.jobTitle }];
      if (input.phone) {
        values.phone_numbers = [{ original_phone_number: input.phone }];
      }
      if (input.companyRecordId) {
        values.company = [
          {
            target_object: "companies",
            target_record_id: input.companyRecordId,
          },
        ];
      }
      const res = await request<RecordResponse>("PUT", path, {
        data: { values },
      });
      return { recordId: recordId(path, res) };
    },

    async assertCompany(input) {
      const path = "/objects/companies/records?matching_attribute=domains";
      const res = await request<RecordResponse>("PUT", path, {
        data: {
          values: {
            domains: [{ domain: input.domain }],
            name: [{ value: input.name }],
          },
        },
      });
      return { recordId: recordId(path, res) };
    },

    async createNote(input) {
      const path = "/notes";
      const res = await request<NoteResponse>("POST", path, {
        data: {
          parent_object: input.parentObject,
          parent_record_id: input.parentRecordId,
          title: input.title,
          format: "plaintext",
          content: input.content,
        },
      });
      const noteId = res.data?.id?.note_id;
      if (!noteId) {
        throw new AttioRequestError(200, path, "response carried no note_id");
      }
      return { noteId };
    },
  };
}
