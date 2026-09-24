import type { Annotation } from "agentation";
import { describe, expect, it } from "vitest";
import { feedbackMarkdown } from "./markdown";

const note = (over: Partial<Annotation>): Annotation => ({ id: "a", x: 0, y: 0, comment: "", element: "button", elementPath: "main > button", timestamp: 0, ...over });

describe("feedbackMarkdown", () => {
  it("lists notes in order with optional context lines", () => {
    const md = feedbackMarkdown("http://localhost:1420/", "Tomo", [
      note({ comment: "wrong  color", element: 'button "Save"', elementPath: "form > .actions > button", selectedText: "Save", reactComponents: "App > Form", sourceFile: "src/Form.tsx:12" }),
      note({ comment: "cut off\ntext", element: "p", elementPath: "main > p", nearbyText: "Hello   world" }),
    ]);
    expect(md).toBe(
      [
        "## Tomo (http://localhost:1420/)",
        "",
        '1. button "Save" `form > .actions > button`',
        "   wrong color",
        '   selected: "Save"',
        "   react: App > Form",
        "   source: src/Form.tsx:12",
        "2. p `main > p`",
        "   cut off text",
        '   nearby: "Hello world"',
      ].join("\n"),
    );
  });

  it("uses the url alone when the page has no title", () => {
    expect(feedbackMarkdown("http://x/", "  ", [])).toBe("## http://x/\n");
  });
});
