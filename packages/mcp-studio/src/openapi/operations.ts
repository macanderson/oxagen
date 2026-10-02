// operations.ts: each operation of the upgraded document as an UpstreamTool
// (mcp-studio-spec, Mapping: OpenAPI).
//
// Path-level and operation-level parameters merge, and the operation's win.
// Every parameter and the request body become one inputSchema, except a
// parameter with content instead of schema, which is skipped with a note.
// Import keeps a parameter an API key scheme names, because only server.toml
// says which scheme a call uses. Compile drops it once it knows.
//
// The 2xx responses give the outputSchema only when they all share one JSON
// schema and that schema is an object, or an array, which is wrapped as
// { items }. An operation or path item with its own servers sends to the
// first of them. Webhooks and callbacks are listed and never become tools.
import { httpUrlSchema } from "../contract/primitives";
import type { ImportNote, ListedEntry } from "../model/import-result";
import {
  cutDescription,
  httpRequestSchema,
  toolSuggestionSchema,
  upstreamToolSchema,
  type HttpBody,
  type HttpParameter,
  type HttpRequest,
  type UpstreamTool,
} from "../model/upstream-tool";
import { baseUrlRefusal, expandServerUrl } from "./auth";
import { deepEqual, isList, isRecord, recordField, setOwn, stringField, type JsonRecord } from "./json";
import { NameSet, fallbackName, toolKeyFrom } from "./names";
import { detectPaging } from "./paging";
import type { Resolver } from "./resolve";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Method = (typeof METHODS)[number];

const LOCATIONS = new Set(["path", "query", "header", "cookie"]);
type Location = HttpParameter["in"];

const STYLES = new Set(["simple", "label", "matrix", "form", "spaceDelimited", "pipeDelimited", "deepObject", "cookie"]);
type Style = NonNullable<HttpParameter["style"]>;

/**
 * The keys a body schema may hold and still be spread into the tool's input.
 * Spreading keeps only the properties and their required list, so any other
 * keyword, such as minProperties, would be lost. Such a body stays whole under
 * one input property instead.
 */
const SPREAD_KEYS = new Set(["type", "properties", "required", "title", "description", "additionalProperties"]);

/** Headers the gateway sets itself, so a tool never takes them as input. */
const GATEWAY_HEADERS = new Set(["accept", "content-type", "authorization"]);

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const PATH_TEMPLATE = /^\/[^\s?#]*$/;

/** OpenAPI's security requirements, as the request template holds them. */
const securitySchema = httpRequestSchema.shape.security.unwrap();

const WEBHOOK_REASON = "A webhook is a request the API sends, so it never becomes a tool.";
const CALLBACK_REASON = "A callback is a request the API sends back to the caller, so it never becomes a tool.";

export interface Operations {
  tools: UpstreamTool[];
  listed: ListedEntry[];
}

/** A media type as a request template writes it: lowercase, with no parameters. */
function normalizeMedia(media: string): string {
  return (media.split(";")[0] ?? "").trim().toLowerCase();
}

function isJson(media: string): boolean {
  return media === "application/json" || media.endsWith("+json");
}

/** A parameter's identity. Header names match without regard to case. */
function parameterKey(where: string, name: string): string {
  return `${where}:${where === "header" ? name.toLowerCase() : name}`;
}

function defaultStyle(where: Location): Style {
  return where === "path" || where === "header" ? "simple" : "form";
}

class ToolBuilder {
  private readonly properties: JsonRecord = {};
  private readonly required: string[] = [];
  private readonly parameters: HttpParameter[] = [];
  private body: HttpBody | undefined;

  constructor(
    private readonly name: string,
    private readonly resolver: Resolver,
    private readonly notes: ImportNote[],
  ) {}

  private note(message: string): void {
    this.notes.push({ tool: this.name, message });
  }

  private takeProperty(name: string, schema: unknown, required: boolean): void {
    setOwn(this.properties, name, schema);
    if (required && !this.required.includes(name)) this.required.push(name);
  }

  private parameterSchema(parameter: JsonRecord): unknown {
    const source = parameter.schema;
    const expanded = source === undefined ? {} : this.resolver.schema(source, "input");
    const schema: JsonRecord = isRecord(expanded) ? { ...expanded } : {};
    const description = stringField(parameter, "description");
    if (description !== undefined) schema.description = description;
    if (parameter.deprecated === true) schema.deprecated = true;
    return schema;
  }

  addParameters(pathLevel: unknown, operationLevel: unknown): void {
    const merged = new Map<string, JsonRecord>();
    for (const list of [pathLevel, operationLevel]) {
      if (!isList(list)) continue;
      for (const raw of list) {
        const parameter = this.resolver.resolveObject(raw);
        if (!isRecord(parameter)) continue;
        const name = stringField(parameter, "name");
        const where = stringField(parameter, "in");
        if (name === undefined || where === undefined) {
          this.note("Import skipped a parameter with no name or no in.");
          continue;
        }
        merged.set(parameterKey(where, name), parameter);
      }
    }
    for (const parameter of merged.values()) {
      const name = parameter.name as string;
      const where = parameter.in as string;
      if (!LOCATIONS.has(where)) {
        this.note(`Import skipped the parameter ${name}, because the gateway does not send a parameter in ${where}.`);
        continue;
      }
      if (where === "header" && GATEWAY_HEADERS.has(name.toLowerCase())) continue;
      if (this.skipContent(name, where, parameter)) continue;
      this.addParameter(name, where as Location, parameter);
    }
  }

  /**
   * A parameter with content instead of schema is sent as that media type,
   * such as JSON text under one name. The template sends a parameter by its
   * style only, so import skips it rather than send the value another way.
   */
  private skipContent(name: string, where: string, parameter: JsonRecord): boolean {
    const content = parameter.schema === undefined ? recordField(parameter, "content") : undefined;
    if (content === undefined) return false;
    const media = normalizeMedia(Object.keys(content)[0] ?? "");
    const as = media === "" ? "content" : media;
    const outcome = parameter.required === true || where === "path" ? " The API requires it, so a call to this tool fails." : "";
    this.note(`Import skipped the ${where} parameter ${name}, because the gateway cannot send a parameter as ${as}.${outcome}`);
    return true;
  }

  private addParameter(name: string, where: Location, parameter: JsonRecord): void {
    let property = name;
    if (Object.hasOwn(this.properties, property)) {
      property = `${name}_${where}`;
      for (let n = 2; Object.hasOwn(this.properties, property); n += 1) property = `${name}_${where}_${n}`;
      this.note(`Two parameters are named ${name}, so the ${where} parameter's input is ${property}.`);
    }
    const required = where === "path" || parameter.required === true;
    this.takeProperty(property, this.parameterSchema(parameter), required);
    const entry: HttpParameter = { name, in: where, property, required };
    const style = stringField(parameter, "style");
    const effective = style !== undefined && STYLES.has(style) ? (style as Style) : defaultStyle(where);
    if (effective !== defaultStyle(where)) entry.style = effective;
    // OpenAPI's explode is true by default for the form and cookie styles.
    const explodes = effective === "form" || effective === "cookie";
    const explode = typeof parameter.explode === "boolean" ? parameter.explode : explodes;
    // A cookie parameter always carries explode, so the executor writes one
    // cookie per item or member exactly when the document says so.
    if (where === "cookie" || explode !== explodes) entry.explode = explode;
    if (where === "query" && parameter.allowReserved === true) entry.allow_reserved = true;
    this.parameters.push(entry);
  }

  /**
   * The media type the body is sent as, by the gateway's preference: JSON,
   * then a form, then text, which the executor can send, and only then
   * multipart or any other type, which it cannot.
   */
  private pickMedia(content: JsonRecord): { key: string; media: string } | undefined {
    const candidates = Object.keys(content)
      .map((key) => ({ key, media: normalizeMedia(key) }))
      .filter((candidate) => MEDIA_TYPE.test(candidate.media));
    const pick = (test: (media: string) => boolean): { key: string; media: string } | undefined =>
      candidates.find((candidate) => test(candidate.media));
    const chosen =
      pick((media) => media === "application/json") ??
      pick((media) => media.endsWith("+json")) ??
      pick((media) => media === "application/x-www-form-urlencoded") ??
      pick((media) => media.startsWith("text/")) ??
      pick((media) => media === "multipart/form-data") ??
      candidates[0];
    if (chosen === undefined) return undefined;
    const sendable =
      isJson(chosen.media) || chosen.media === "application/x-www-form-urlencoded" || chosen.media.startsWith("text/");
    if (!sendable) {
      this.note(`This tool sends ${chosen.media}, which the gateway cannot send yet, so a call to this tool fails.`);
    }
    return chosen;
  }

  addBody(raw: unknown): void {
    if (raw === undefined) return;
    const body = this.resolver.resolveObject(raw);
    const content = isRecord(body) ? recordField(body, "content") : undefined;
    if (!isRecord(body) || content === undefined) return;
    const chosen = this.pickMedia(content);
    if (chosen === undefined) {
      this.note("Import found no request body media type it can name, so this tool sends no body.");
      return;
    }
    const mediaObject = content[chosen.key];
    const source = isRecord(mediaObject) ? mediaObject.schema : undefined;
    const expanded = source === undefined ? {} : this.resolver.schema(source, "input");
    const schema: JsonRecord = isRecord(expanded) ? expanded : {};
    const required = body.required === true;

    const bodyProperties = isRecord(schema.properties) ? schema.properties : {};
    const names = Object.keys(bodyProperties);
    const extra = schema.additionalProperties;
    const bodyRequired = isList(schema.required) ? schema.required : [];
    // A spread body's members sit beside the parameters, so the input cannot
    // say "these are required once any of them is sent". An optional body
    // with required members therefore stays whole, and so does a body whose
    // schema holds a keyword spreading would drop.
    const spreadable =
      schema.type === "object" &&
      names.length > 0 &&
      Object.keys(schema).every((key) => SPREAD_KEYS.has(key)) &&
      (extra === undefined || extra === false) &&
      (required || bodyRequired.length === 0) &&
      names.every((name) => !Object.hasOwn(this.properties, name));

    if (spreadable) {
      for (const name of names) {
        this.takeProperty(name, bodyProperties[name], required && bodyRequired.includes(name));
      }
      this.body = { in: "spread", media_type: chosen.media, required, properties: names };
      return;
    }
    let property = "body";
    for (let n = 2; Object.hasOwn(this.properties, property); n += 1) {
      property = n === 2 ? "request_body" : `request_body_${n}`;
    }
    const description = stringField(body, "description");
    const carried = description !== undefined && schema.description === undefined ? { ...schema, description } : schema;
    this.takeProperty(property, carried, required);
    this.body = { in: "property", media_type: chosen.media, required, property };
  }

  inputSchema(): JsonRecord {
    const schema: JsonRecord = { type: "object", properties: this.properties };
    if (this.required.length > 0) schema.required = this.required;
    return schema;
  }

  build(): { parameters: HttpParameter[]; body: HttpBody | undefined } {
    return { parameters: this.parameters, body: this.body };
  }
}

type ReadResponse = { response: NonNullable<HttpRequest["response"]>; output: JsonRecord | undefined };

/** One 2xx response: its JSON media type and expanded schema, or neither when it has no JSON schema. */
interface Success {
  code: string;
  media_type: string | undefined;
  schema: unknown;
}

function readSuccess(code: string, raw: unknown, resolver: Resolver): Success {
  const response = resolver.resolveObject(raw);
  const content = isRecord(response) ? recordField(response, "content") : undefined;
  if (content === undefined) return { code, media_type: undefined, schema: undefined };
  const keys = Object.keys(content).filter((key) => {
    const media = normalizeMedia(key);
    const entry = content[key];
    return isJson(media) && MEDIA_TYPE.test(media) && isRecord(entry) && entry.schema !== undefined;
  });
  const key = keys.find((item) => normalizeMedia(item) === "application/json") ?? keys[0];
  if (key === undefined) return { code, media_type: undefined, schema: undefined };
  const entry = content[key] as JsonRecord;
  return { code, media_type: normalizeMedia(key), schema: resolver.schema(entry.schema, "output") };
}

/** "200", "200 and 204", or "200, 201, and 204". */
function listCodes(codes: readonly string[]): string {
  if (codes.length <= 2) return codes.join(" and ");
  return `${codes.slice(0, -1).join(", ")}, and ${codes[codes.length - 1]}`;
}

/**
 * The response the result comes from, and the outputSchema. The executor
 * accepts every 2xx status, so the outputSchema is advertised only when every
 * declared 2xx response has the same JSON schema. Otherwise a successful call
 * could return a result that breaks it.
 */
function readResponse(responses: JsonRecord, resolver: Resolver, note: (message: string) => void): ReadResponse | undefined {
  const codes = Object.keys(responses)
    .filter((code) => /^2[0-9]{2}$/.test(code))
    .sort();
  if (Object.hasOwn(responses, "2XX")) codes.push("2XX");
  const successes = codes.map((code) => readSuccess(code, responses[code], resolver));
  const first = successes.find((success) => success.media_type !== undefined);
  if (first === undefined) return undefined;
  const read = shapeOutput(first.code, first.media_type as string, first.schema);
  if (read.output === undefined) {
    if (nullableContainer(first.schema)) {
      note(
        `Import left out this tool's output schema, because the ${first.code} response may be null, and a tool's output schema must describe an object.`,
      );
    }
    return read;
  }
  const differs = successes.some((success) => success !== first && (success.media_type === undefined || !deepEqual(success.schema, first.schema)));
  if (differs) {
    note(
      `Import left out this tool's output schema, because its successful responses (${listCodes(codes)}) do not share one JSON schema.`,
    );
    return { response: { status: read.response.status, media_type: read.response.media_type }, output: undefined };
  }
  return read;
}

/** The schema's type list without "null", when it has "null" beside other types. */
function nonNullTypes(schema: JsonRecord): unknown[] | undefined {
  const type = schema.type;
  if (!isList(type) || !type.includes("null")) return undefined;
  return type.filter((item) => item !== "null");
}

/** True for type ["object", "null"] or ["array", "null"]: a result that would have an outputSchema if it could not be null. */
function nullableContainer(schema: unknown): boolean {
  const others = isRecord(schema) ? nonNullTypes(schema) : undefined;
  return others?.length === 1 && (others[0] === "object" || others[0] === "array");
}

/**
 * True when every value the schema allows is an object. An untyped schema
 * counts when each oneOf or anyOf branch is an object, when an allOf part is
 * one, or when it has properties and no oneOf or anyOf.
 */
function objectShaped(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type !== undefined) return schema.type === "object";
  const branches = [schema.oneOf, schema.anyOf].filter((list) => list !== undefined);
  if (branches.length > 0) return branches.every((list) => isList(list) && list.length > 0 && list.every(objectShaped));
  if (isList(schema.allOf) && schema.allOf.some(objectShaped)) return true;
  return isRecord(schema.properties);
}

/**
 * MCP needs an object result. An array result is wrapped as { items }. A
 * scalar, a value that may be null, and a composition with a branch that is
 * not an object have no outputSchema. The HTTP interpreter returns those
 * values unchanged, so an object schema would not describe them.
 */
function shapeOutput(status: string, media_type: string, schema: unknown): ReadResponse {
  const response: NonNullable<HttpRequest["response"]> = { status, media_type };
  if (!isRecord(schema)) return { response, output: undefined };
  if (schema.type === "array") {
    // The template wraps a result only beside the { items } schema that describes it.
    response.wrap = "items";
    return { response, output: { type: "object", properties: { items: schema }, required: ["items"] } };
  }
  if (objectShaped(schema)) return { response, output: { ...schema, type: "object" } };
  return { response, output: undefined };
}

function describeOperation(operation: JsonRecord): string | undefined {
  const summary = stringField(operation, "summary")?.trim() ?? "";
  const description = stringField(operation, "description")?.trim() ?? "";
  const text =
    summary !== "" && description !== "" && summary !== description
      ? `${summary}\n\n${description}`
      : summary !== ""
        ? summary
        : description;
  return text === "" ? undefined : cutDescription(text);
}

function firstIssue(error: { issues: readonly { path: readonly (string | number)[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (issue === undefined) return "it is not valid";
  return issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`;
}

/** A servers list's urls, each with its variables' defaults filled in, or undefined for no list or an empty one. */
function serverUrls(servers: unknown): { raw: string; url: string }[] | undefined {
  if (!isList(servers)) return undefined;
  const urls: { raw: string; url: string }[] = [];
  for (const server of servers) {
    if (!isRecord(server)) continue;
    const raw = stringField(server, "url");
    if (raw !== undefined) urls.push({ raw, url: expandServerUrl(raw, server) });
  }
  return urls.length === 0 ? undefined : urls;
}

/** A server url as two lists compare it: without a trailing slash. */
function serverKey(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The operation's base url, or why a call cannot use its server. */
type OwnServer = { base_url: string | undefined; note: string | undefined } | { refusal: string };

class OperationReader {
  private readonly names = new NameSet();
  /** The document's own servers, which the environments come from. */
  private readonly rootServers: ReadonlySet<string>;
  readonly tools: UpstreamTool[] = [];
  readonly listed: ListedEntry[] = [];

  constructor(
    private readonly document: JsonRecord,
    private readonly resolver: Resolver,
    private readonly notes: ImportNote[],
  ) {
    this.rootServers = new Set((serverUrls(document.servers) ?? []).map(({ url }) => serverKey(url)));
  }

  /**
   * The nearest servers override, from the operation, then its path item. A
   * list that names the document's servers again is no override, because the
   * environments already come from them. Any other list overrides them, so
   * the tool sends to its first url in every environment. A url the executor
   * cannot use as a base url is refused, so the call never falls back to the
   * environment's url.
   */
  private ownServer(pathServers: unknown, operation: JsonRecord): OwnServer {
    const own = serverUrls(operation.servers) ?? serverUrls(pathServers);
    if (own === undefined) return { base_url: undefined, note: undefined };
    const keys = new Set(own.map(({ url }) => serverKey(url)));
    if (keys.size === this.rootServers.size && [...keys].every((key) => this.rootServers.has(key))) {
      return { base_url: undefined, note: undefined };
    }
    const [{ raw, url }] = own as [{ raw: string; url: string }];
    const why = httpUrlSchema.safeParse(url).success
      ? baseUrlRefusal(url)
      : "It is not an absolute http or https URL, and import does not know where the document is served.";
    if (why !== undefined) return { refusal: `its own server "${raw}" cannot be a tool call's base url. ${why}` };
    const others = own.length > 1 ? ` The document lists ${own.length} servers for it, and import took the first.` : "";
    return { base_url: url, note: `This tool sends to ${url} in every environment, because the document gives the operation its own server.${others}` };
  }

  private note(tool: string | undefined, message: string): void {
    this.notes.push({ tool, message });
  }

  readPaths(): void {
    const paths = recordField(this.document, "paths") ?? {};
    for (const [path, raw] of Object.entries(paths)) {
      if (!PATH_TEMPLATE.test(path)) {
        this.note(undefined, `Import skipped the path "${path}", because a path starts with / and has no spaces, query, or fragment.`);
        continue;
      }
      const item = this.resolver.resolveObject(raw);
      if (!isRecord(item)) continue;
      for (const method of METHODS) {
        const operation = item[method];
        if (isRecord(operation)) this.readOperation(path, method, item, operation);
      }
    }
  }

  readWebhooks(): void {
    const webhooks = recordField(this.document, "webhooks") ?? {};
    for (const name of Object.keys(webhooks)) {
      this.listed.push({ name, kind: "webhook", reason: WEBHOOK_REASON });
    }
  }

  private suggestion(operation: JsonRecord): { value: UpstreamTool["suggestion"]; problem: string | undefined } {
    const hint = operation["x-oxagen-tool"];
    if (hint === undefined) return { value: undefined, problem: undefined };
    const parsed = toolSuggestionSchema.safeParse(hint);
    if (!parsed.success) return { value: undefined, problem: firstIssue(parsed.error) };
    return { value: Object.keys(parsed.data).length > 0 ? parsed.data : undefined, problem: undefined };
  }

  private readOperation(path: string, method: Method, item: JsonRecord, operation: JsonRecord): void {
    const METHOD = method.toUpperCase() as HttpRequest["method"];
    const operationId = stringField(operation, "operationId");
    const suggestion = this.suggestion(operation);
    const base =
      suggestion.value?.name ??
      (operationId === undefined ? undefined : toolKeyFrom(operationId)) ??
      fallbackName(method, path);
    const name = this.names.claim(base);
    if (name !== base) this.note(name, `Import named this tool ${name}, because another operation already took ${base}.`);
    if (suggestion.problem !== undefined) {
      this.note(name, `Import ignored x-oxagen-tool on ${METHOD} ${path}, because it is not valid: ${suggestion.problem}.`);
    }
    const server = this.ownServer(item.servers, operation);
    if ("refusal" in server) {
      this.note(name, `Import skipped ${METHOD} ${path}, because ${server.refusal}`);
      return;
    }
    if (server.note !== undefined) this.note(name, server.note);
    this.resolver.beginTool(name);

    const builder = new ToolBuilder(name, this.resolver, this.notes);
    builder.addParameters(item.parameters, operation.parameters);
    builder.addBody(operation.requestBody);
    const { parameters, body } = builder.build();
    const read = readResponse(recordField(operation, "responses") ?? {}, this.resolver, (message) => this.note(name, message));

    const request: HttpRequest = {
      kind: "http",
      operation: operationId !== undefined && operationId.length > 0 && operationId.length <= 256 ? operationId : `${METHOD} ${path}`,
      method: METHOD,
      path,
      parameters,
    };
    if (server.base_url !== undefined) request.base_url = server.base_url;
    if (body !== undefined) request.body = body;
    if (read !== undefined) request.response = read.response;
    const security = isList(operation.security) ? operation.security : this.document.security;
    if (security !== undefined) {
      const parsed = securitySchema.safeParse(security);
      if (parsed.success) request.security = parsed.data;
      else this.note(name, `Import dropped the security requirements of ${METHOD} ${path}, because they are not valid: ${firstIssue(parsed.error)}.`);
    }

    const tool: UpstreamTool = { name, inputSchema: builder.inputSchema() as UpstreamTool["inputSchema"], request };
    const description = describeOperation(operation);
    if (description !== undefined) tool.description = description;
    if (read?.output !== undefined) tool.outputSchema = read.output as UpstreamTool["inputSchema"];
    if (method === "put" || method === "delete") tool.annotations = { idempotentHint: true };
    if (operation.deprecated === true) {
      tool.deprecated = true;
      this.note(name, "The document marks this operation deprecated.");
    }
    if (suggestion.value !== undefined) tool.suggestion = suggestion.value;
    const paging = detectPaging(parameters, read?.output, read?.response.wrap === "items");
    if (paging !== undefined) tool.paging = paging;

    const parsed = upstreamToolSchema.safeParse(tool);
    if (!parsed.success) {
      this.note(name, `Import skipped ${METHOD} ${path}, because its tool is not valid: ${firstIssue(parsed.error)}.`);
    } else {
      this.tools.push(tool);
    }

    const callbacks = recordField(operation, "callbacks") ?? {};
    for (const callback of Object.keys(callbacks)) {
      this.listed.push({ name: `${name}.${callback}`, kind: "callback", reason: CALLBACK_REASON });
    }
  }
}

/** Every operation as a tool, and every webhook and callback as a listed entry. */
export function readOperations(document: JsonRecord, resolver: Resolver, notes: ImportNote[]): Operations {
  const reader = new OperationReader(document, resolver, notes);
  reader.readPaths();
  reader.readWebhooks();
  return { tools: reader.tools, listed: reader.listed };
}
