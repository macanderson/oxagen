// source.ts: one .proto file parsed by protobufjs, plus the header facts
// protobufjs does not keep.
//
// protobufjs parses a file into reflection objects without protoc and without
// a native build step. Its parse result drops two things the descriptor set
// needs: which syntax the file declares, and each import's kind in declaration
// order (it folds `import public` into the plain imports). scanHeader reads
// them from the file's top-level statements with protobufjs's own tokenizer.
import protobuf from "protobufjs";
import type { IParserResult, Root } from "protobufjs";
import { GrpcImportError } from "./errors";
import { messageOf } from "./limits";

export type ImportKind = "plain" | "public" | "weak";

export interface ProtoImport {
  path: string;
  kind: ImportKind;
}

export interface ProtoHeader {
  syntax: "proto2" | "proto3";
  /** Every import statement, in the order the file declares them. */
  imports: ProtoImport[];
}

export interface ParsedProto {
  /** The file's name in the descriptor set: its path under proto/. */
  name: string;
  text: string;
  root: Root;
  package: string | undefined;
  header: ProtoHeader;
}

/** The file parsed, or a refusal that quotes protobufjs's error with its line. */
export function parseProto(name: string, text: string): ParsedProto {
  let parsed: IParserResult;
  try {
    parsed = protobuf.parse(text, new protobuf.Root(), { keepCase: true, alternateCommentMode: true });
  } catch (error) {
    throw new GrpcImportError("parse", `${name} does not parse: ${messageOf(error)}. Fix the file and import it again.`, name);
  }
  return { name, text, root: parsed.root, package: parsed.package, header: scanHeader(name, text) };
}

const QUOTES = new Set(['"', "'"]);

/**
 * The syntax and the imports, from the statements at the top level of the
 * file. A file with no syntax statement is proto2, as protoc reads it. It
 * runs after protobufjs has parsed the file, so the statements are well formed.
 */
export function scanHeader(name: string, text: string): ProtoHeader {
  const tokens = protobuf.tokenize(text, true);
  const header: ProtoHeader = { syntax: "proto2", imports: [] };
  /** Reads a string literal whose opening quote was just read, with any literals that follow it. */
  const literal = (): string => {
    let value = "";
    for (;;) {
      value += tokens.next() ?? "";
      tokens.next();
      const after = tokens.peek();
      if (after === null || !QUOTES.has(after)) return value;
      tokens.next();
    }
  };
  let depth = 0;
  let atStatement = true;
  for (let token = tokens.next(); token !== null; token = tokens.next()) {
    if (QUOTES.has(token)) {
      literal();
      atStatement = false;
    } else if (token === "{") {
      depth += 1;
      atStatement = false;
    } else if (token === "}") {
      depth -= 1;
      atStatement = depth === 0;
    } else if (token === ";") {
      atStatement = depth === 0;
    } else if (atStatement) {
      atStatement = false;
      if (token === "syntax") {
        tokens.next();
        tokens.next();
        header.syntax = literal() === "proto3" ? "proto3" : "proto2";
      } else if (token === "edition") {
        throw new GrpcImportError(
          "unsupported",
          `${name} declares an edition. Import reads proto2 and proto3 files, so declare syntax = "proto3" or "proto2" instead.`,
          name,
        );
      } else if (token === "import") {
        // The token after `import` is a modifier or the opening quote.
        const first = tokens.next();
        const kind: ImportKind = first === "public" || first === "weak" ? first : "plain";
        if (kind !== "plain") tokens.next();
        header.imports.push({ path: literal(), kind });
      }
    }
  }
  return header;
}
