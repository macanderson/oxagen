// symbols.ts: every full name the files declare, and protoc's rule for which
// definition a type name in a file refers to.
//
// The table is built from FileDescriptorProtos, so the bundled well-known
// types and the files import builds register the same way. It holds packages,
// messages (map entries included), enums, and services. Fields, enum values,
// oneofs, and methods are left out: protoc skips each of them when it looks
// up a type, so the lookup below finds what protoc's LookupSymbol finds.
import type { DescriptorProto, FileDescriptorProto } from "@bufbuild/protobuf/wkt";
import { GrpcImportError } from "./errors";

export type SymbolKind = "package" | "message" | "enum" | "service";

export interface FoundSymbol {
  /** The full name, with no leading dot. */
  name: string;
  kind: SymbolKind;
}

/** Why a lookup that protoc would explain found nothing. */
export type LookupMiss =
  /** A dotted name whose first part an inner scope holds, so protoc reads the name from there and finds nothing. */
  | { reason: "shadowed"; first: FoundSymbol; readAs: string }
  /** A one-part name whose innermost match is not a type, such as a service, and no outer scope defines a type. */
  | { reason: "not_type"; found: FoundSymbol };

interface Entry {
  kind: SymbolKind;
  /** The files that declare it. Only a package has more than one. */
  files: Set<string>;
}

export class Symbols {
  private readonly entries = new Map<string, Entry>();

  /** Adds every name the file declares. A name declared twice is refused. */
  register(file: FileDescriptorProto): void {
    if (file.package !== "") {
      const parts = file.package.split(".");
      for (let end = 1; end <= parts.length; end += 1) this.addPackage(parts.slice(0, end).join("."), file.name);
    }
    const scope = file.package === "" ? "" : `${file.package}.`;
    for (const message of file.messageType) this.addMessage(scope, message, file.name);
    for (const enumType of file.enumType) this.add(`${scope}${enumType.name}`, "enum", file.name);
    for (const service of file.service) this.add(`${scope}${service.name}`, "service", file.name);
  }

  /**
   * The definition `ref` names when it is written inside `scope` (the full
   * name of the message, service, or package that holds the reference), as
   * protoc resolves it. `visible` is the set of files the referring file
   * can see: itself, its imports, and what they import publicly.
   *
   * A name with a leading dot is a full name. Otherwise protoc tries the
   * name's first part in each enclosing scope, innermost first. When the
   * first part is found and the name has more parts, the rest must follow
   * from there. When a one-part name finds something that is not a type,
   * the search goes on outward.
   */
  lookup(ref: string, scope: string, visible: ReadonlySet<string>): FoundSymbol | undefined {
    if (ref.startsWith(".")) return this.find(ref.slice(1), visible);
    const dot = ref.indexOf(".");
    const first = dot === -1 ? ref : ref.slice(0, dot);
    const parts = scope === "" ? [] : scope.split(".");
    for (let end = parts.length; end > 0; end -= 1) {
      const prefix = parts.slice(0, end).join(".");
      const found = this.find(`${prefix}.${first}`, visible);
      if (found === undefined) continue;
      if (dot !== -1) return this.find(`${prefix}.${ref}`, visible);
      if (found.kind === "message" || found.kind === "enum") return found;
    }
    return this.find(ref, visible);
  }

  /**
   * Why lookup found nothing for `ref`, when protoc says more than that
   * nothing defines it, or undefined when nothing more explains it. It walks
   * the scopes as lookup does.
   */
  explain(ref: string, scope: string, visible: ReadonlySet<string>): LookupMiss | undefined {
    if (ref.startsWith(".")) return undefined;
    const dot = ref.indexOf(".");
    const first = dot === -1 ? ref : ref.slice(0, dot);
    const parts = scope === "" ? [] : scope.split(".");
    for (let end = parts.length; end > 0; end -= 1) {
      const prefix = parts.slice(0, end).join(".");
      const found = this.find(`${prefix}.${first}`, visible);
      if (found === undefined) continue;
      if (dot !== -1) return { reason: "shadowed", first: found, readAs: `${prefix}.${ref}` };
      if (found.kind !== "message" && found.kind !== "enum") return { reason: "not_type", found };
    }
    return undefined;
  }

  /** The definition with this full name, when one of the visible files declares it. */
  find(name: string, visible: ReadonlySet<string>): FoundSymbol | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    for (const file of entry.files) if (visible.has(file)) return { name, kind: entry.kind };
    return undefined;
  }

  /** The file that declares this full name, visible or not, for a refusal that names a missing import. */
  declaredIn(name: string): string | undefined {
    const [first] = this.entries.get(name)?.files ?? [];
    return first;
  }

  private addMessage(scope: string, message: DescriptorProto, file: string): void {
    const name = `${scope}${message.name}`;
    this.add(name, "message", file);
    for (const nested of message.nestedType) this.addMessage(`${name}.`, nested, file);
    for (const enumType of message.enumType) this.add(`${name}.${enumType.name}`, "enum", file);
  }

  private addPackage(name: string, file: string): void {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      this.entries.set(name, { kind: "package", files: new Set([file]) });
    } else if (entry.kind === "package") {
      entry.files.add(file);
    } else {
      throw duplicate(name, entry, file);
    }
  }

  private add(name: string, kind: Exclude<SymbolKind, "package">, file: string): void {
    const entry = this.entries.get(name);
    if (entry !== undefined) throw duplicate(name, entry, file);
    this.entries.set(name, { kind, files: new Set([file]) });
  }
}

function duplicate(name: string, entry: Entry, file: string): GrpcImportError {
  const [first = file] = entry.files;
  const where = first === file ? `${file} defines ${name} twice` : `${file} defines ${name}, which ${first} already defines`;
  return new GrpcImportError("duplicate", `${where}. Rename one of them.`, file);
}
