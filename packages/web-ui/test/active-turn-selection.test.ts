import { describe, expect, it } from "vitest";
import { selectActiveTurn } from "../src/active-turn-selection.ts";

const anchors = [
  { turnId: "turn-1", top: 40 },
  { turnId: "turn-2", top: 100 },
  { turnId: "turn-3", top: 520 },
] as const;

describe("active conversation-turn selection", () => {
  it("selects the latest Turn above the reading line", () => {
    expect(
      selectActiveTurn({
        anchors,
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 300,
        scrollerTop: 0,
      }),
    ).toBe("turn-2");
  });

  it("selects the final Turn at the scroll boundary", () => {
    expect(
      selectActiveTurn({
        anchors,
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 1_000,
        scrollerTop: 0,
      }),
    ).toBe("turn-3");
    expect(
      selectActiveTurn({
        anchors,
        clientHeight: 800,
        scrollHeight: 700,
        scrollTop: 0,
        scrollerTop: 0,
      }),
    ).toBe("turn-3");
  });
});
