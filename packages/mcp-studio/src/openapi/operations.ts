// operations.ts: each operation of the upgraded document as an UpstreamTool
// (mcp-studio-spec, Mapping: OpenAPI).
//
// Path-level and operation-level parameters merge, and the operation's win.
// Every parameter and the request body become one inputSchema, except a
// parameter with content instead of schema, which is skipped with a note.
// The first 2xx response with a JSON schema becomes the outputSchema, and an
// array result is wrapped as { items }. Webhooks and callbacks are listed and
// never become tools.
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
import { isList, isRecord, recordField, setOwn, stringField, type JsonRecord } from "./json";
import { NameSet, fallbackName, toolKeyFrom } from "./names";
import { detectPaging } from "./paging";
import type { Resolver } from "./resolve";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Method = (typeof METHODS)[number];

const LOCATIONS = new Set(["path", "query", "header", "cookie"]);
type Location = HttpParameter["in"];

const STYLES = new Set(["simple", "label", "matrix", "form", "spaceDelimited", "pipeDelimited", "deepObject"]);
type Style = NonNullable<HttpParameter["style"]>;

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

/** The parameters an apiKey scheme names. The gateway adds them, so no tool takes them as input. */
function apiKeyParameters(document: JsonRecord, resolver: Resolver): Set<string> {
  const keys = new Set<string>();
  const schemes = recordField(recordField(document, "components") ?? {}, "securitySchemes") ?? {};
  for (const raw of Object.values(schemes)) {
    const scheme = resolver.resolveObject(raw);
    if (!isRecord(scheme) || scheme.type !== "apiKey") continue;
    const where = stringField(scheme, "in");
    const name = stringField(scheme, "name");
    if (where !== undefined && name !== undefined) keys.add(parameterKey(where, name));
  }
  return keys;
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
    private readonly skipped: ReadonlySet<string>,
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
    for (const [key, parameter] of merged) {
      const name = parameter.name as string;
      const where = parameter.in as string;
      if (!LOCATIONS.has(where)) {
        this.note(`Import skipped the parameter ${name}, because the gateway does not send a parameter in ${where}.`);
        continue;
      }
      if (this.skipped.has(key)) continue;
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
    const explode = parameter.explode;
    if (typeof explode === "boolean" && explode !== (effective === "form")) entry.explode = explode;
    this.parameters.push(entry);
  }

  /** The media type the body is sent as, by the gateway's preference. */
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
      pick((media) => media === "multipart/form-data") ??
      pick((media) => media.startsWith("text/")) ??
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
    const spreadable =
      schema.type === "object" &&
      names.length > 0 &&
      schema.allOf === undefined &&
      schema.anyOf === undefined &&
      schema.oneOf === undefined &&
      schema.patternProperties === undefined &&
      (extra === undefined || extra === false) &&
      names.every((name) => !Object.hasOwn(this.properties, name));

    if (spreadable) {
      const bodyRequired = isList(schema.required) ? schema.required : [];
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

/** The response the result comes from, and the outputSchema, when a 2xx response has a JSON schema. */
function readResponse(
  responses: JsonRecord,
  resolver: Resolver,
): { response: NonNullable<HttpRequest["response"]>; output: JsonRecord | undefined } | undefined {
  const codes = Object.keys(responses)
    .filter((code) => /^2[0-9]{2}$/.test(code))
    .sort();
  if (Object.hasOwn(responses, "2XX")) codes.push("2XX");
  for (const code of codes) {
    const response = resolver.resolveObject(responses[code]);
    const content = isRecord(response) ? recordField(response, "content") : undefined;
    if (content === undefined) continue;
    const keys = Object.keys(content).filter((key) => {
      const media = normalizeMedia(key);
      const entry = content[key];
      return isJson(media) && MEDIA_TYPE.test(media) && isRecord(entry) && entry.schema !== undefined;
    });
    const key = keys.find((item) => normalizeMedia(item) === "application/json") ?? keys[0];
    if (key === undefined) continue;
    const entry = content[key] as JsonRecord;
    const expanded = resolver.schema(entry.schema, "output");
    const media_type = normalizeMedia(key);
    return shapeOutput(code, media_type, expanded);
  }
  return undefined;
}

/** MCP needs an object result. An array result is wrapped as { items }, and a scalar one has no outputSchema. */
function shapeOutput(
  status: string,
  media_type: string,
  schema: unknown,
): { response: NonNullable<HttpRequest["response"]>; output: JsonRecord | undefined } {
  const response: NonNullable<HttpRequest["response"]> = { status, media_type };
  if (!isRecord(schema)) return { response, output: undefined };
  const type = schema.type;
  const nullable = (name: string): boolean =>
    isList(type) && type.length === 2 && type.includes(name) && type.includes("null");
  if (type === "object" || nullable("object")) return { response, output: { ...schema, type: "object" } };
  if (type === "array" || nullable("array")) {
    response.wrap = "items";
    return { response, output: { type: "object", properties: { items: schema }, required: ["items"] } };
  }
  const composed = schema.allOf !== undefined || schema.anyOf !== undefined || schema.oneOf !== undefined;
  if (type === undefined && (isRecord(schema.properties) || composed)) {
    return { response, output: { ...schema, type: "object" } };
  }
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

class OperationReader {
  private readonly names = new NameSet();
  private readonly skipped: ReadonlySet<string>;
  readonly tools: UpstreamTool[] = [];
  readonly listed: ListedEntry[] = [];

  constructor(
    private readonly document: JsonRecord,
    private readonly resolver: Resolver,
    private readonly notes: ImportNote[],
  ) {
    this.skipped = apiKeyParameters(document, resolver);
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
        if (isRecord(operation)) this.readOperation(path, method, item.parameters, operation);
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

  private readOperation(path: string, method: Method, pathParameters: unknown, operation: JsonRecord): void {
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
    this.resolver.beginTool(name);

    const builder = new ToolBuilder(name, this.resolver, this.notes, this.skipped);
    builder.addParameters(pathParameters, operation.parameters);
    builder.addBody(operation.requestBody);
    const { parameters, body } = builder.build();
    const read = readResponse(recordField(operation, "responses") ?? {}, this.resolver);

    const request: HttpRequest = {
      kind: "http",
      operation: operationId !== undefined && operationId.length > 0 && operationId.length <= 256 ? operationId : `${METHOD} ${path}`,
      method: METHOD,
      path,
      parameters,
    };
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
