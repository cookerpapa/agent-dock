import { describe, expect, it } from "vitest";
import { selectConversationNavigationTarget } from "../src/ConversationTreeNavigator.tsx";

describe("conversation tree navigation targets", () => {
  it("prefers an inherited Pi entry anchor over the Child Turn fallback", () => {
    const inherited = { kind: "inherited" };
    const childTurn = { kind: "turn" };
    expect(
      selectConversationNavigationTarget(
        new Map([["entry-1", inherited]]),
        new Map([["turn-1", childTurn]]),
        { entryId: "entry-1", turnId: "turn-1" },
      ),
    ).toBe(inherited);
  });

  it("falls back to the Turn anchor for ordinary conversation entries", () => {
    const childTurn = { kind: "turn" };
    expect(
      selectConversationNavigationTarget(new Map(), new Map([["turn-1", childTurn]]), {
        entryId: "entry-missing",
        turnId: "turn-1",
      }),
    ).toBe(childTurn);
  });
});
