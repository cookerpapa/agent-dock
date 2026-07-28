import { useEffect, useRef, useState, type RefObject } from "react";
import type { TurnView } from "./session-view.ts";

const PROGRAMMATIC_SCROLL_GUARD_MS = 1_000;
const SCROLL_END_TOLERANCE_PX = 2;

interface TurnAnchor {
  readonly turnId: string;
  readonly top: number;
}

export function selectActiveOutlineTurn(input: {
  readonly anchors: readonly TurnAnchor[];
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly scrollerTop: number;
}): string | null {
  const first = input.anchors[0];
  if (first === undefined) return null;
  if (input.scrollHeight - input.scrollTop <= input.clientHeight + SCROLL_END_TOLERANCE_PX) {
    return input.anchors.at(-1)?.turnId ?? first.turnId;
  }

  const activationLine = input.scrollerTop + Math.min(120, Math.max(0, input.clientHeight) * 0.3);
  let current = first.turnId;
  for (const anchor of input.anchors) {
    if (anchor.top > activationLine) break;
    current = anchor.turnId;
  }
  return current;
}

function outlineLabel(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim() || "未命名问题";
}

function elementsByTurnId(scroller: HTMLElement): ReadonlyMap<string, HTMLElement> {
  const elements = new Map<string, HTMLElement>();
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-conversation-turn-id]")) {
    const turnId = element.dataset.conversationTurnId;
    if (turnId !== undefined) elements.set(turnId, element);
  }
  return elements;
}

export function ConversationOutline({
  turns,
  scrollerRef,
}: {
  turns: readonly TurnView[];
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(
    () => turns.at(-1)?.turnId ?? null,
  );
  const jumpTargetRef = useRef<string | null>(null);
  const jumpReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnIds = turns.map((turn) => turn.turnId);
  const turnIdentity = turnIds.join("\u0000");

  useEffect(() => {
    if (activeTurnId !== null && turnIds.includes(activeTurnId)) return;
    setActiveTurnId(turnIds.at(-1) ?? null);
  }, [activeTurnId, turnIdentity]);

  useEffect(
    () => () => {
      if (jumpReleaseTimerRef.current !== null) clearTimeout(jumpReleaseTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || turnIds.length === 0) return;
    const updateActiveTurn = (): void => {
      if (jumpTargetRef.current !== null) return;
      const scrollerBounds = scroller.getBoundingClientRect();
      const elements = elementsByTurnId(scroller);
      setActiveTurnId(
        selectActiveOutlineTurn({
          anchors: turnIds.flatMap((turnId) => {
            const element = elements.get(turnId);
            return element === undefined
              ? []
              : [{ turnId, top: element.getBoundingClientRect().top }];
          }),
          clientHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
          scrollerTop: scrollerBounds.top,
        }),
      );
    };
    scroller.addEventListener("scroll", updateActiveTurn, { passive: true });
    updateActiveTurn();
    return () => {
      scroller.removeEventListener("scroll", updateActiveTurn);
    };
  }, [scrollerRef, turnIdentity]);

  function jumpToTurn(turnId: string): void {
    const scroller = scrollerRef.current;
    const target = scroller === null ? undefined : elementsByTurnId(scroller).get(turnId);
    jumpTargetRef.current = turnId;
    if (jumpReleaseTimerRef.current !== null) clearTimeout(jumpReleaseTimerRef.current);
    setActiveTurnId(turnId);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    jumpReleaseTimerRef.current = setTimeout(() => {
      jumpTargetRef.current = null;
      jumpReleaseTimerRef.current = null;
    }, PROGRAMMATIC_SCROLL_GUARD_MS);
  }

  return (
    <aside className="product-conversation-outline" aria-label="历史问题导航">
      <header>
        <div>
          <strong>对话导航</strong>
          <span>快速跳转到历史问题</span>
        </div>
        <small>{String(turns.length)}</small>
      </header>
      <nav>
        {turns.map((turn, index) => (
          <button
            aria-current={activeTurnId === turn.turnId ? "true" : undefined}
            className={activeTurnId === turn.turnId ? "active" : ""}
            key={turn.turnId}
            onClick={() => jumpToTurn(turn.turnId)}
            title={outlineLabel(turn.prompt)}
            type="button"
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{outlineLabel(turn.prompt)}</strong>
          </button>
        ))}
      </nav>
    </aside>
  );
}
