import { describe, expect, it } from "vitest";
import { highlightSource, sourceLanguage } from "../src/source-highlight.ts";

describe("source highlighting", () => {
  it("selects a language from the write path and produces escaped token markup", () => {
    expect(sourceLanguage("/workspace/bubble_sort.py")).toBe("python");
    expect(
      highlightSource("def bubble_sort(values):\n    return values", "bubble_sort.py"),
    ).toEqual(
      expect.objectContaining({
        language: "python",
        html: expect.stringContaining('<span class="hljs-keyword">def</span>'),
      }),
    );
    expect(highlightSource("<script>alert(1)</script>", "page.html")?.html).not.toContain(
      "<script>",
    );
  });

  it("keeps unknown extensions as plain source", () => {
    expect(sourceLanguage("/workspace/LICENSE")).toBeNull();
    expect(highlightSource("plain text", "/workspace/LICENSE")).toBeNull();
  });
});
