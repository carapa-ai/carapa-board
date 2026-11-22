// Shared size for the card multi-select checkbox and the column header
// "select all" checkbox so the two cannot drift apart. Mouse: 14px box. Coarse
// pointer: 20px box plus a transparent 32px hit area (an ::after overlay
// reaching 6px past the border box; it counts as the checkbox for clicks) and a
// slightly larger check/minus icon to stay proportionate.
export const SELECT_CHECKBOX_CLASS =
  'size-3.5 pointer-coarse:size-5 pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:-inset-[7px] pointer-coarse:[&_svg]:size-3.5';
