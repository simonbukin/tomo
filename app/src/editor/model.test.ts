import { describe, expect, it } from "vitest";
import { diskRead, dismiss, edited, failed, initialDoc, keepMine, loaded, minimalChange, opened, planSave, reload, saved, titleOf, type EditorDoc } from "./model";

const file = (version: string, text = `text ${version}`) => ({ kind: "file" as const, version, text });
const missing = { kind: "missing" as const };
const dirty = (doc: EditorDoc) => edited(doc, true);

describe("editor model", () => {
  it("opens a file clean, and a missing file empty with a notice", () => {
    expect(opened(file("v1", "a"))).toEqual({ doc: loaded("v1"), reload: "a" });
    const fresh = opened(missing);
    expect(fresh.reload).toBe("");
    expect(fresh.doc.notice).toEqual({ kind: "deleted" });
    expect(planSave(fresh.doc)).toEqual({ kind: "write", expected: null });
  });

  it("reloads a clean buffer silently when the disk changes", () => {
    expect(diskRead(loaded("v1"), file("v2", "new"))).toEqual({ doc: loaded("v2"), reload: "new" });
  });

  it("ignores an event when the disk still has the base version", () => {
    const doc = dirty(loaded("v1"));
    expect(diskRead(doc, file("v1"))).toEqual({ doc });
  });

  it("keeps edits and shows a notice when the disk changes under them", () => {
    const step = diskRead(dirty(loaded("v1")), file("v2", "agent"));
    expect(step.reload).toBeUndefined();
    expect(step.doc.notice).toEqual({ kind: "changed", version: "v2", text: "agent" });
    expect(step.doc.dirty).toBe(true);
  });

  it("clears the notice when the disk goes back to the base", () => {
    const changed = diskRead(dirty(loaded("v1")), file("v2")).doc;
    expect(diskRead(changed, file("v1")).doc.notice).toBeNull();
  });

  it("reload takes the disk text and discards the edits", () => {
    const changed = diskRead(dirty(loaded("v1")), file("v2", "agent")).doc;
    expect(reload(changed)).toEqual({ doc: loaded("v2"), reload: "agent" });
    expect(reload(loaded("v1"))).toEqual({ doc: loaded("v1") });
  });

  it("keep mine needs a confirm on the next save, against the disk version it saw", () => {
    const changed = diskRead(dirty(loaded("v1")), file("v2")).doc;
    expect(planSave(changed)).toEqual({ kind: "confirm", expected: "v2" });
    const mine = keepMine(changed);
    expect(mine.notice).toBeNull();
    expect(planSave(mine)).toEqual({ kind: "confirm", expected: "v2" });
    expect(diskRead(mine, file("v2")).doc).toEqual(mine);
    const again = diskRead(mine, file("v3")).doc;
    expect(again.notice).toMatchObject({ kind: "changed", version: "v3" });
    expect(planSave(again)).toEqual({ kind: "confirm", expected: "v3" });
  });

  it("a save writes against the base, and a finished save is clean", () => {
    const doc = dirty(loaded("v1"));
    expect(planSave(doc)).toEqual({ kind: "write", expected: "v1" });
    expect(saved("v2", false)).toEqual(loaded("v2"));
    expect(saved("v2", true)).toEqual({ ...loaded("v2"), dirty: true });
    expect(planSave(initialDoc).kind).toBe("none");
  });

  it("a deleted file says so, keeps the buffer, and a save recreates it", () => {
    for (const start of [loaded("v1"), dirty(loaded("v1"))]) {
      const step = diskRead(start, missing);
      expect(step.reload).toBeUndefined();
      expect(step.doc.notice).toEqual({ kind: "deleted" });
      expect(step.doc.dirty).toBe(start.dirty);
      expect(planSave(step.doc)).toEqual({ kind: "write", expected: null });
      expect(dismiss(step.doc).notice).toBeNull();
    }
  });

  it("a file that comes back reloads a clean buffer and warns a dirty one", () => {
    const gone = diskRead(loaded("v1"), missing).doc;
    expect(diskRead(gone, file("v2", "back"))).toEqual({ doc: loaded("v2"), reload: "back" });
    expect(diskRead(dirty(gone), file("v2")).doc.notice).toMatchObject({ kind: "changed", version: "v2" });
  });

  it("an error stays until the next good read", () => {
    const doc = failed(loaded("v1"), "disk full");
    expect(doc.error).toBe("disk full");
    expect(diskRead(doc, file("v1")).doc.error).toBeNull();
  });

  it("the minimal change keeps the common start and end", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
    expect(minimalChange("", "x")).toEqual({ from: 0, to: 0, insert: "x" });
    const apply = (a: string, b: string) => {
      const c = minimalChange(a, b)!;
      return a.slice(0, c.from) + c.insert + a.slice(c.to);
    };
    expect(apply("one\ntwo\nthree", "one\n2\nthree")).toBe("one\n2\nthree");
    expect(apply("abab", "ab")).toBe("ab");
  });

  it("the title shows a dot for edits", () => {
    expect(titleOf("src/main.rs", false)).toBe("main.rs");
    expect(titleOf("src/main.rs", true)).toBe("● main.rs");
  });
});
