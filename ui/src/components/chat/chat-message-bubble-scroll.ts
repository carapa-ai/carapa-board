export type InnerScrollState = {
  pinned: boolean;
  scrollTop: number;
};

export function nextInnerPinnedState(
  currentPinned: boolean,
  scrollTop: number,
  lastScrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  if (distanceFromBottom <= 1) return true;
  return scrollTop < lastScrollTop ? false : currentPinned;
}

export function handoffInnerScrollTop(
  scrollHeight: number,
  previousState: InnerScrollState | null | undefined,
): number {
  return previousState?.pinned === false
    ? previousState.scrollTop
    : scrollHeight;
}
