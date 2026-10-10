import { errorMessage, type Api, type Row } from "./api";

export type BoardDetail = Row & { item: Row; cards: Row[]; columns: Row[] };
export type MoveIntent = { cardId: string; columnId: string; position: number };
export type BoardMoveState = {
  detail: BoardDetail;
  pending: MoveIntent[];
  saving: boolean;
  recovering: boolean;
  recovered: boolean;
  error: string;
};

/** One ordered writer per board. Views subscribe/unsubscribe without cancelling saves. */
export class BoardMoveQueue {
  private base: BoardDetail;
  private pending: MoveIntent[] = [];
  private saving = false;
  private recovering = false;
  private recovered = false;
  private error = "";
  private listeners = new Set<(state: BoardMoveState) => void>();

  constructor(private readonly api: Api, detail: BoardDetail) { this.base = detail; }

  snapshot(): BoardMoveState {
    // An earlier acknowledgement updates only the saved base; replay every later
    // intent over it, including another move of the very same card.
    const cards = this.error ? this.base.cards : this.pending.reduce((rows, intent) => rows.map(card =>
      card.id === intent.cardId ? { ...card, columnId: intent.columnId, position: intent.position } : card
    ), this.base.cards);
    return { detail: { ...this.base, cards }, pending: this.pending.map(intent => ({ ...intent })), saving: this.saving, recovering: this.recovering, recovered: this.recovered, error: this.error };
  }

  subscribe(listener: (state: BoardMoveState) => void) {
    this.listeners.add(listener); listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  private publish() { const state = this.snapshot(); this.listeners.forEach(listener => listener(state)); }

  replaceSaved(detail: BoardDetail) {
    if (detail.item.id !== this.base.item.id) throw new Error("Cannot replace another board.");
    if (this.pending.length || this.saving || this.recovering || this.error) return;
    this.base = detail; this.publish();
  }

  enqueue(intent: MoveIntent) {
    if (this.error) return;
    if (!this.base.cards.some(card => card.id === intent.cardId) || !this.base.columns.some(column => column.id === intent.columnId)) return;
    this.pending.push({ ...intent }); this.publish();
    void this.drain();
  }

  private async drain() {
    if (this.saving || this.recovering || this.error || !this.pending.length) return;
    this.saving = true; this.publish();
    try {
      while (this.pending.length) {
        const intent = this.pending[0], card = this.base.cards.find(row => row.id === intent.cardId);
        if (!card || !this.base.columns.some(column => column.id === intent.columnId)) throw new Error("A pending task or destination column no longer exists. Discard the pending moves and choose a new destination.");
        const result = await this.api(`planning/v1/cards/${intent.cardId}/move`, "POST", {
          expectedRevision: card.revision, expectedBoardRevision: this.base.item.revision,
          columnId: intent.columnId, position: intent.position,
        });
        if (result.board?.id !== this.base.item.id || result.item?.id !== intent.cardId) throw new Error("The save response did not match this board.");
        this.base = { ...this.base, item: result.board, cards: this.base.cards.map(row => row.id === intent.cardId ? result.item : row) };
        this.pending.shift(); this.publish();
      }
    } catch (error) {
      this.error = `We couldn't confirm a move. ${errorMessage(error)}`;
      // Fail closed: never replay against another actor's newly read revisions
      // without a deliberate review/apply action from the user.
      await this.refreshFailed();
    } finally { this.saving = false; this.publish(); }
  }

  async refreshFailed() {
    if (!this.error || this.recovering) return;
    this.recovering = true; this.recovered = false; this.publish();
    try {
      const detail: BoardDetail = await this.api(`planning/v1/boards/${this.base.item.id}`, "GET", undefined, undefined, { fresh: true });
      if (detail.item?.id !== this.base.item.id) throw new Error("The latest response did not match this board.");
      this.base = detail; this.recovered = true;
    } catch (error) {
      this.error = `Pending moves are paused. The latest saved board could not be loaded. ${errorMessage(error)}`;
    } finally { this.recovering = false; this.publish(); }
  }

  retryReviewed() {
    if (!this.error || !this.recovered || this.recovering || this.saving) return;
    if (this.pending.some(intent => !this.base.cards.some(card => card.id === intent.cardId) || !this.base.columns.some(column => column.id === intent.columnId))) {
      this.error = "A pending task or destination column was removed. Discard the pending moves and choose a new destination."; this.publish(); return;
    }
    this.error = ""; this.recovered = false; this.publish(); void this.drain();
  }

  discardReviewed() {
    if (!this.recovered || this.recovering || this.saving) return;
    this.pending = []; this.error = ""; this.recovered = false; this.publish();
  }
}
