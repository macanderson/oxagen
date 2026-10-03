/**
 * array-params.ts — array query parameters that fit the request URL (#5311).
 *
 * @clickhouse/client sends every query parameter as one field of the request
 * URL (`param_<name>`). ClickHouse refuses a field longer than
 * `http_max_field_value_size` (128 KiB by default) with "HTML Form Exception:
 * Field value too long", and a URL longer than `http_max_uri_size` (1 MiB by
 * default), before it reads the query. A list that grows with the data, such
 * as a run's sessions or the price book's boundaries, is split here.
 */

/**
 * Values one array parameter carries at most. A UUID, the widest value these
 * reads send, takes 45 bytes of the URL once the client quotes it and the URL
 * encodes it (`%27`, 36 characters, `%27%2C`), so 1,000 of them take about
 * 45 KB.
 */
export const ARRAY_PARAM_VALUES_MAX = 1_000;

/**
 * Array parameters one read splits a list across at most. Ten full ones take
 * about 450 KB of a 1 MiB URL.
 */
export const ARRAY_PARAMS_MAX = 10;

/**
 * `values` split into array parameters of at most
 * {@link ARRAY_PARAM_VALUES_MAX} values: `name`, then `name1`, `name2` and
 * on. An empty list is one empty parameter, so a list that fits one
 * parameter binds as it always has. Null when the list needs more than
 * {@link ARRAY_PARAMS_MAX} parameters.
 */
export function splitArrayParam<T>(
  name: string,
  values: readonly T[],
): [string, T[]][] | null {
  const count = Math.max(1, Math.ceil(values.length / ARRAY_PARAM_VALUES_MAX));
  if (count > ARRAY_PARAMS_MAX) return null;
  const out: [string, T[]][] = [];
  for (let i = 0; i < count; i += 1)
    out.push([
      i === 0 ? name : `${name}${i}`,
      values.slice(i * ARRAY_PARAM_VALUES_MAX, (i + 1) * ARRAY_PARAM_VALUES_MAX),
    ]);
  return out;
}

/**
 * The predicate that names the listed sessions by the table's sort key, split
 * across `sessionUuids` array parameters, and the parameters it binds. The
 * parts join with OR, so the read returns the rows one parameter would. Null
 * when the list is too long for the URL, and the caller reads another way.
 */
export function sessionListFilter(sessions: readonly string[]): {
  sql: string;
  params: Record<string, string[]>;
} | null {
  const split = splitArrayParam("sessionUuids", sessions);
  if (split === null) return null;
  const terms = split.map(([name]) => `session_uuid IN {${name}:Array(UUID)}`);
  return {
    sql: terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`,
    params: Object.fromEntries(split),
  };
}

/**
 * `sessions` in batches of at most {@link ARRAY_PARAM_VALUES_MAX}. A read
 * whose every row belongs to one chain returns the same rows when it reads
 * the batches one at a time and joins the answers, so it can read a list of
 * any length this way.
 */
export function sessionBatches(sessions: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < sessions.length; i += ARRAY_PARAM_VALUES_MAX)
    out.push(sessions.slice(i, i + ARRAY_PARAM_VALUES_MAX));
  return out;
}
