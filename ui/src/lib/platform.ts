// Older Android (≤10 / API < 30) WebViews collapse the layout viewport to ~36 px
// when the IME opens with adjustResize, and report no signal with adjustNothing.
// We apply a JS-driven workaround only for those devices; on newer Androids the
// platform handles the keyboard correctly and the original CSS-only layout works.
export const isOldAndroid = (() => {
  const m = /Android (\d+)/.exec(navigator.userAgent);
  if (!m) return false;
  return parseInt(m[1], 10) < 11;
})();
