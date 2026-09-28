// set.ts: the .proto files under proto/, with everything they import, as one
// FileDescriptorSet.
//
// Import never reads a disk. An import statement resolves against the files
// it was given, named by their path under proto/, which is the include path
// protoc and buf use for a server folder. A well-known type the folder does
// not hold comes from @bufbuild/protobuf (wkt.ts). The set lists each file
// after the files it imports, as buf build does, and every type name in it is
// resolved by protoc's scoping rule (symbols.ts). @bufbuild/protobuf's
// registry then reads the set, which checks it the way the executor will.
import { create, createFileRegistry, toBinary, type FileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema, type FileDescriptorProto } from "@bufbuild/protobuf/wkt";
import type { Notes } from "../graphql/notes";
import type { ImportedFile } from "../model/import-result";
import { normalizePath } from "../openapi/ref-path";
import { buildFile, type BuiltFile, type PendingRef } from "./descriptors";
import { GrpcImportError } from "./errors";
import { count, DEFINITION_BYTES_MAX, messageOf } from "./limits";
import { parseProto, type ParsedProto } from "./source";
import { Symbols } from "./symbols";
import { bundledWkt } from "./wkt";

/** The folder under a server's folder that holds its .proto files, and the root of every import path. */
export const PROTO_DIR = "proto/";

export interface ProtoSet {
  /** Every file, each after the files it imports: the files given, and the well-known types they import. */
  files: FileDescriptorProto[];
  /** The serialized FileDescriptorSet the executor encodes and decodes with. */
  descriptorSet: Uint8Array;
  registry: FileRegistry;
  /** Each definition's leading comment, by full name. */
  comments: Map<string, string>;
}

/** A file on the import walk: parsed from the folder, or a bundled well-known type. */
type Loaded = { kind: "source"; parsed: ParsedProto } | { kind: "bundled"; proto: FileDescriptorProto };

/**
 * The files as one descriptor set, or a refusal that names the file and says
 * what to change: too large, a path outside proto/, a missing import, an
 * import cycle, a name defined twice, or a type name nothing defines.
 */
export function buildSet(input: readonly ImportedFile[], notes: Notes): ProtoSet {
  const sources = namedSources(input);
  const loaded = new Map<string, Loaded>();
  const order = importOrder(sources, loaded);

  const symbols = new Symbols();
  const built = new Map<string, BuiltFile>();
  const files: FileDescriptorProto[] = [];
  for (const name of order) {
    const entry = loaded.get(name);
    if (entry === undefined) continue;
    const proto = entry.kind === "source" ? remember(built, name, buildFile(entry.parsed, notes)) : entry.proto;
    symbols.register(proto);
    files.push(proto);
  }

  const visibility = new Visibility(files);
  const everyFile = new Set(files.map((file) => file.name));
  const comments = new Map<string, string>();
  const customOptions = new Set<string>();
  for (const [name, file] of built) {
    const visible = visibility.of(name);
    for (const ref of file.pending) resolve(ref, name, visible, everyFile, symbols);
    for (const [key, text] of file.comments) comments.set(key, text);
    for (const option of file.customOptions) customOptions.add(option);
  }
  if (customOptions.size > 0) {
    notes.add(
      undefined,
      `The files set the custom options ${[...customOptions].sort().join(", ")}. The descriptor set leaves them out, because the gateway reads none of them.`,
    );
  }

  const set = create(FileDescriptorSetSchema, { file: files });
  let registry: FileRegistry;
  try {
    registry = createFileRegistry(set);
  } catch (error) {
    throw new GrpcImportError(
      "invalid",
      `The files do not form a valid descriptor set: ${messageOf(error)}. Fix the definition and import again.`,
    );
  }
  return { files, descriptorSet: toBinary(FileDescriptorSetSchema, set), registry, comments };
}

/** A path under proto/ as the name imports use: proto/ledger/v1/ledger.proto is ledger/v1/ledger.proto. */
export function protoName(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === undefined) {
    throw new GrpcImportError(
      "path",
      `${path} points outside the server folder. Give each file's path inside the folder, such as proto/ledger/v1/ledger.proto.`,
      path,
    );
  }
  if (!normalized.startsWith(PROTO_DIR)) {
    throw new GrpcImportError(
      "path",
      `${path} is outside proto/. Import reads the .proto files in the server's proto/ folder, so move the file there.`,
      path,
    );
  }
  if (!normalized.endsWith(".proto")) {
    throw new GrpcImportError("path", `${path} is not a .proto file. Pass only the .proto files under proto/.`, path);
  }
  return normalized.slice(PROTO_DIR.length);
}

/** The files by the name imports use, after the size, path, and duplicate checks. */
function namedSources(input: readonly ImportedFile[]): Map<string, ImportedFile> {
  if (input.length === 0) {
    throw new GrpcImportError("empty", "Import was given no .proto files. Pass the files under proto/ with the files they import.");
  }
  const encoder = new TextEncoder();
  const bytes = input.reduce((sum, file) => sum + encoder.encode(file.text).byteLength, 0);
  if (bytes > DEFINITION_BYTES_MAX) {
    throw new GrpcImportError(
      "too_large",
      `The .proto files come to ${count(bytes)} bytes. Import refuses a definition over 25 MB, so import only the files the services need.`,
    );
  }
  const sources = new Map<string, ImportedFile>();
  for (const file of input) {
    const name = protoName(file.path);
    const earlier = sources.get(name);
    if (earlier !== undefined) {
      throw new GrpcImportError(
        "duplicate",
        `${earlier.path} and ${file.path} are the same file, proto/${name}. Pass each file once.`,
        name,
      );
    }
    sources.set(name, file);
  }
  return sources;
}

interface Frame {
  name: string;
  imports: string[];
  next: number;
}

/**
 * Every file the sources reach, each after the files it imports. The walk
 * starts from each source in name order and keeps its own stack, so a long
 * import chain cannot overflow the call stack. It fills `loaded` as it goes.
 */
function importOrder(sources: ReadonlyMap<string, ImportedFile>, loaded: Map<string, Loaded>): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const stack: Frame[] = [];
  const open = (name: string, importer: string | undefined): void => {
    const entry = load(name, importer, sources);
    loaded.set(name, entry);
    const imports = entry.kind === "source" ? entry.parsed.header.imports.map((each) => each.path) : entry.proto.dependency;
    stack.push({ name, imports, next: 0 });
  };

  for (const root of [...sources.keys()].sort()) {
    if (done.has(root)) continue;
    open(root, undefined);
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const next = top.imports[top.next];
      top.next += 1;
      if (next === undefined) {
        stack.pop();
        done.add(top.name);
        order.push(top.name);
      } else if (!done.has(next)) {
        const at = stack.findIndex((frame) => frame.name === next);
        if (at !== -1) throw cycle([...stack.slice(at).map((frame) => frame.name), next]);
        open(next, top.name);
      }
    }
  }
  return order;
}

/** Reads one file: a source parsed with its import paths checked, or a bundled well-known type. */
function load(name: string, importer: string | undefined, sources: ReadonlyMap<string, ImportedFile>): Loaded {
  const source = sources.get(name);
  if (source !== undefined) {
    const parsed = parseProto(name, source.text);
    checkImports(parsed);
    return { kind: "source", parsed };
  }
  const proto = bundledWkt(name);
  if (proto !== undefined) return { kind: "bundled", proto };
  throw new GrpcImportError(
    "import_missing",
    `${importer ?? name} imports ${name}, which is not among the files. Add proto/${name} with the other .proto files and import again.`,
    importer,
  );
}

/** Each import path is written from proto/, once. */
function checkImports(parsed: ParsedProto): void {
  const seen = new Set<string>();
  for (const { path } of parsed.header.imports) {
    const normalized = normalizePath(path);
    if (normalized === undefined) {
      throw new GrpcImportError(
        "path",
        `${parsed.name} imports "${path}", which points outside proto/. Import paths start at proto/, so write the path from there.`,
        parsed.name,
      );
    }
    if (normalized !== path) {
      throw new GrpcImportError(
        "path",
        `${parsed.name} imports "${path}". Import paths start at proto/ with no ./ or .. parts, so write "${normalized}".`,
        parsed.name,
      );
    }
    if (seen.has(path)) {
      throw new GrpcImportError(
        "duplicate",
        `${parsed.name} imports ${path} twice. Remove one of the import statements.`,
        parsed.name,
      );
    }
    seen.add(path);
  }
}

function cycle(chain: readonly string[]): GrpcImportError {
  const steps = chain.slice(1).map((to, index) => `${chain[index] ?? ""} imports ${to}`);
  const listed = steps.length <= 2 ? steps.join(" and ") : `${steps.slice(0, -1).join(", ")}, and ${steps.at(-1) ?? ""}`;
  return new GrpcImportError(
    "import_cycle",
    `The imports form a cycle: ${listed}. Protobuf does not allow an import cycle, so move what the files share into a new file that each of them imports.`,
    chain[0],
  );
}

function remember(built: Map<string, BuiltFile>, name: string, file: BuiltFile): FileDescriptorProto {
  built.set(name, file);
  return file.proto;
}

/**
 * The files each file can see, as protoc defines it: the file itself, the
 * files it imports, and every file those import publicly, followed through
 * further public imports.
 */
export class Visibility {
  private readonly byName = new Map<string, FileDescriptorProto>();
  private readonly exported = new Map<string, Set<string>>();

  constructor(files: readonly FileDescriptorProto[]) {
    for (const file of files) this.byName.set(file.name, file);
  }

  of(name: string): Set<string> {
    const visible = new Set([name]);
    for (const dependency of this.byName.get(name)?.dependency ?? []) {
      for (const each of this.exportedBy(dependency)) visible.add(each);
    }
    return visible;
  }

  /**
   * A file and every file it re-exports through `import public`. The set is
   * cached before the walk, so a cycle of public imports, which reflection
   * can return before buildSet refuses it, ends.
   */
  private exportedBy(name: string): Set<string> {
    const cached = this.exported.get(name);
    if (cached !== undefined) return cached;
    const out = new Set([name]);
    this.exported.set(name, out);
    const file = this.byName.get(name);
    for (const index of file?.publicDependency ?? []) {
      const dependency = file?.dependency[index];
      if (dependency !== undefined) for (const each of this.exportedBy(dependency)) out.add(each);
    }
    return out;
  }
}

/** Resolves one type name, or refuses it with the import or the definition it lacks. */
function resolve(
  ref: PendingRef,
  file: string,
  visible: ReadonlySet<string>,
  everyFile: ReadonlySet<string>,
  symbols: Symbols,
): void {
  const found = symbols.lookup(ref.ref, ref.scope, visible);
  if (found === undefined) {
    const everywhere = symbols.lookup(ref.ref, ref.scope, everyFile);
    const declaredIn = everywhere === undefined ? undefined : symbols.declaredIn(everywhere.name);
    if (declaredIn !== undefined) {
      throw new GrpcImportError(
        "unresolved",
        `In ${file}, ${ref.holder} names ${ref.ref}, which ${declaredIn} defines, but ${file} does not import ${declaredIn}. Add import "${declaredIn}"; to ${file}.`,
        file,
      );
    }
    throw new GrpcImportError(
      "unresolved",
      `In ${file}, ${ref.holder} names ${ref.ref}, which none of its imports defines. Define ${ref.ref}, or import the file that does.`,
      file,
    );
  }
  const wanted = ref.accepts === "message" ? "a message" : "a message or an enum";
  if (found.kind === "package" || found.kind === "service" || (ref.accepts === "message" && found.kind === "enum")) {
    throw new GrpcImportError(
      "unresolved",
      `In ${file}, ${ref.holder} names ${ref.ref}, which is the ${found.kind} ${found.name}. It must name ${wanted}.`,
      file,
    );
  }
  ref.resolve(found.name, found.kind);
}
