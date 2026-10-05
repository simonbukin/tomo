import { describe, expect, it } from "vitest";
import { absolutePath, fileUrl, fileView, VIEWS } from "./fileView";

const nodeFsWithoutNodeTypes = "node:fs";
const { readFileSync } = await import(/* @vite-ignore */ nodeFsWithoutNodeTypes);
const viewerRs: string = readFileSync("src-tauri/src/viewer.rs", "utf8");

describe("the view of a file", () => {
  it("picks the view by the extension, in any case, and text for the rest", () => {
    expect(fileView("shots/a.PNG")).toBe("image");
    expect(fileView("/tmp/run.mov")).toBe("video");
    expect(fileView("voice.m4a")).toBe("audio");
    expect(fileView("spec.pdf")).toBe("pdf");
    expect(fileView("src/main.rs")).toBe("text");
    expect(fileView("Makefile")).toBe("text");
    expect(fileView(".png")).toBe("text");
    expect(fileView("clip.mkv")).toBe("text");
  });

  it("asks for only the files that the tomo-file scheme serves", () => {
    for (const ext of Object.keys(VIEWS)) expect(viewerRs, ext).toMatch(new RegExp(`"${ext}"`));
  });

  it("finds the file of a pane inside and outside its worktree", () => {
    expect(absolutePath("/src/kobe", "shots/a.png")).toBe("/src/kobe/shots/a.png");
    expect(absolutePath("/src/kobe", "/tmp/a.png")).toBe("/tmp/a.png");
  });

  it("encodes the whole path, and changes the address when the file changes", () => {
    expect(fileUrl("/tmp/a b#1.png", 0)).toBe("tomo-file://localhost/%2Ftmp%2Fa%20b%231.png?v=0");
    expect(fileUrl("/tmp/a.png", 1)).not.toBe(fileUrl("/tmp/a.png", 2));
  });
});
