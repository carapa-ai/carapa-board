// Android soft keyboards report text keys as keyCode 229 / code "" and never
// emit modifier, arrow, Tab, Escape or function keys. Seeing any of those (or
// a letter/digit with a real `code`) means a physical keyboard is attached, so
// Enter should submit like on desktop. Sticky for the page lifetime.
const PHYSICAL_KEY_CODE =
  /^(Key[A-Z]|Digit\d|Numpad\d|Arrow(Up|Down|Left|Right)|Shift|Control|Alt|Meta|Tab|Escape|F\d{1,2}|Home|End|PageUp|PageDown|Delete)/;

let hardwareKeyboardSeen = false;

/** Records the event and reports whether a physical keyboard has been seen. */
export function noteKeyboardEvent(e: {
  code: string;
  nativeEvent?: { keyCode?: number };
}): boolean {
  if (
    !hardwareKeyboardSeen &&
    e.nativeEvent?.keyCode !== 229 &&
    PHYSICAL_KEY_CODE.test(e.code)
  ) {
    hardwareKeyboardSeen = true;
  }
  return hardwareKeyboardSeen;
}
