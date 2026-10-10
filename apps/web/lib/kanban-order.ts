/** Fractional positions match Planning's existing revision-checked move contract. */
export function positionBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return before + (after - before) / 2;
}
