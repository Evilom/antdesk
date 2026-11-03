// The native task hub is the single writer for assistant reorder requests.
// Rank-derived color is shared by normal slots and the in-flight drag preview.
export function rankTier(index) {
  return index < 3 ? index + 1 : 'rest';
}

export function previewRank(index, drag) {
  if (!drag) return index;
  if (index === drag.from) return drag.to;
  if (index > drag.from && index <= drag.to) return index - 1;
  if (index < drag.from && index >= drag.to) return index + 1;
  return index;
}
