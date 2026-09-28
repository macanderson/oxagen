/**
 * `remoteDigests` digests a repository name the way a Tacho host digests its
 * remote, so a name on the control plane and a remote on the host match.
 */
import { canonicalRemote, digestBytes, foldedRemote } from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import { remoteDigests } from "./remote-digests";

describe("remoteDigests", () => {
  it("matches the digests a host computes from its clone URL", () => {
    const host = canonicalRemote("git@github.com:Acme/Platform.git");
    expect(remoteDigests("github.com/Acme/Platform")).toEqual([
      digestBytes(host),
      digestBytes(foldedRemote(host)),
    ]);
  });

  it("lists one digest when folding changes nothing", () => {
    const digests = remoteDigests("github.com/acme/platform");
    expect(digests).toEqual([digestBytes("github.com/acme/platform")]);
  });

  it("keeps the path's case on a forge that does not ignore it", () => {
    expect(remoteDigests("git.example.com/Acme/Platform")).toEqual([
      digestBytes("git.example.com/Acme/Platform"),
    ]);
  });

  it("matches a lowercase record name to a remote typed in another case", () => {
    const [folded] = remoteDigests("github.com/acme/platform");
    expect(remoteDigests("github.com/Acme/Platform")).toContain(folded);
  });
});
