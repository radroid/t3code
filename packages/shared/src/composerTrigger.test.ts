import { describe, expect, it } from "vite-plus/test";

import {
  replaceTextRange,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

// The mobile composer's newline button inserts "\n" at the caret through this
// same insert-at-selection helper it uses for @file / skill tokens. These cover
// the newline cases specifically so the button's behaviour stays pinned.
describe("replaceTextRange newline insertion", () => {
  it("inserts a newline at a collapsed caret in the middle of the text", () => {
    expect(replaceTextRange("abcd", 2, 2, "\n")).toEqual({
      text: "ab\ncd",
      cursor: 3,
    });
  });

  it("inserts a newline at the end of the text", () => {
    expect(replaceTextRange("abc", 3, 3, "\n")).toEqual({
      text: "abc\n",
      cursor: 4,
    });
  });

  it("replaces a selection range with a newline", () => {
    expect(replaceTextRange("abcdef", 1, 4, "\n")).toEqual({
      text: "a\nef",
      cursor: 2,
    });
  });
});
