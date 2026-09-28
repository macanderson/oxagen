// codec.ts: a skill as the policy bundle carries it, and back.
//
// The control plane chooses a session's skills (`runSkills` in
// @oxagen/steering-bundle) and sends them in the signed bundle. JSON holds
// text, so a file the steering repo stores as bytes travels as base64 and
// comes back as the same bytes. A text file travels as itself.
import { Buffer } from "node:buffer";
import type { BundleSkill, BundleSkillFile } from "../wire";
import type { SessionSkill, SkillFile } from "./place";

function encodeFile(file: SkillFile): BundleSkillFile {
  return typeof file.content === "string"
    ? { path: file.path, encoding: "utf8", content: file.content }
    : {
        path: file.path,
        encoding: "base64",
        content: Buffer.from(file.content).toString("base64"),
      };
}

function decodeFile(file: BundleSkillFile): SkillFile {
  return file.encoding === "utf8"
    ? { path: file.path, content: file.content }
    : { path: file.path, content: new Uint8Array(Buffer.from(file.content, "base64")) };
}

/** A skill as the bundle carries it. */
export function encodeSkill(skill: SessionSkill): BundleSkill {
  return {
    lineage: skill.lineage,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    files: skill.files.map(encodeFile),
    source: skill.source,
    version: skill.version,
  };
}

/** A skill from the bundle, as session start writes it. */
export function decodeSkill(skill: BundleSkill): SessionSkill {
  return {
    lineage: skill.lineage,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    files: skill.files.map(decodeFile),
    source: skill.source,
    version: skill.version,
  };
}
