const SCROLL_END_TOLERANCE_PX = 2;

export function selectActiveTurn(input: {
  readonly anchors: readonly { readonly turnId: string; readonly top: number }[];
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
