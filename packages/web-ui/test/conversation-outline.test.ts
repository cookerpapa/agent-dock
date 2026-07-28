import { describe, expect, it } from "vitest";
import { selectActiveOutlineTurn } from "../src/ConversationOutline.tsx";

const anchors = [
  { turnId: "turn-1", top: 40 },
  { turnId: "turn-2", top: 100 },
  { turnId: "turn-3", top: 520 },
] as const;

describe("conversation outline selection", () => {
  it("selects the latest turn above the reading line", () => {
    expect(
      selectActiveOutlineTurn({
        anchors,
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 300,
        scrollerTop: 0,
      }),
    ).toBe("turn-2");
  });

  it("selects the last turn at the bottom even when it cannot align with the reading line", () => {
    expect(
      selectActiveOutlineTurn({
        anchors,
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 1_000,
        scrollerTop: 0,
      }),
    ).toBe("turn-3");
  });

  it("selects the latest turn when the transcript fits without scrolling", () => {
    expect(
      selectActiveOutlineTurn({
        anchors,
        clientHeight: 800,
        scrollHeight: 700,
        scrollTop: 0,
        scrollerTop: 0,
      }),
    ).toBe("turn-3");
  });
});
