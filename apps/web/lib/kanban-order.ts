/** Fractional positions match Planning's existing revision-checked move contract. */
export function positionBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return before + (after - before) / 2;
}

type PositionedCard = { id: string; columnId: string; position: number };
/** Keyboard navigation expresses a column/row choice, independent of viewport scrolling. */
export function keyboardTaskStep<T extends PositionedCard>(cards: T[], columns: {id: string}[], activeId: string, key: string) {
  const active = cards.find(card => card.id === activeId);
  if (!active) return null;
  let columnId = active.columnId, at = 0, targetId: string;
  const ordered = (id: string) => cards.filter(card => card.columnId === id).sort((a,b) => a.position-b.position || a.id.localeCompare(b.id));
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const next = columns[columns.findIndex(column => column.id === columnId) + (key === 'ArrowRight' ? 1 : -1)];
    if (!next) return null;
    columnId = next.id; targetId = ordered(columnId)[0]?.id ?? columnId;
  } else if (key === 'ArrowUp' || key === 'ArrowDown') {
    const rows = ordered(columnId), nextIndex = rows.findIndex(card => card.id === activeId) + (key === 'ArrowDown' ? 1 : -1);
    if (!rows[nextIndex]) return null;
    at = nextIndex; targetId = rows[nextIndex].id;
  } else return null;
  const siblings = ordered(columnId).filter(card => card.id !== activeId);
  const position = positionBetween(siblings[at-1]?.position, siblings[at]?.position);
  return { columnId, targetId, cards: cards.map(card => card.id === activeId ? {...card, columnId, position} : card) };
}
