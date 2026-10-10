import assert from "node:assert/strict";
import test from "node:test";
import { BoardMoveQueue, type BoardDetail } from "../lib/kanban-mutations.js";
import type { Api, Row } from "../lib/api.js";

function detail(id = "board-one"): BoardDetail {
  return { item: { id, studentId: "student", revision: 10 }, canManageStructure: true,
    columns: [{ id: "todo" }, { id: "doing" }, { id: "done" }],
    cards: [{ id: `${id}-a`, title: "Task A", columnId: "todo", position: 0, revision: 3 }, { id: `${id}-b`, title: "Task B", columnId: "todo", position: 1, revision: 7 }] };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(initial = detail()) {
  let saved = initial, readError: Error | undefined;
  const requests: { path: string; body: Row; reply: ReturnType<typeof deferred<Row>> }[] = [];
  const reads: { path: string; fresh?: boolean }[] = [];
  const api: Api = async (path, method, body, _key, options) => {
    if (method === "GET") { reads.push({ path, fresh: options?.fresh }); if (readError) throw readError; return saved; }
    const reply = deferred<Row>(); requests.push({ path, body: body as Row, reply }); return reply.promise;
  };
  const queue = new BoardMoveQueue(api, initial);
  return { queue, requests, reads, api, saved: () => saved, setSaved: (value: BoardDetail) => { saved = value; }, failReads: (error?: Error) => { readError = error; },
    acknowledge(index: number) {
      const request = requests[index], id = request.path.split("/").at(-2), before = saved.cards.find(card => card.id === id)!;
      assert.equal(request.body.expectedRevision, before.revision);
      assert.equal(request.body.expectedBoardRevision, saved.item.revision);
      const card: Row = { ...before, columnId: request.body.columnId, position: request.body.position, revision: before.revision + 1 };
      saved = { ...saved, item: { ...saved.item, revision: saved.item.revision + 1 }, cards: saved.cards.map(row => row.id === card.id ? card : row) };
      request.reply.resolve({ item: card, board: saved.item });
    } };
}

test("serializes rapid moves on different cards and replays later intent over earlier acknowledgements", async () => {
  const h = harness(), first = h.queue.snapshot().detail.cards[0], second = h.queue.snapshot().detail.cards[1];
  h.queue.enqueue({ cardId: first.id, columnId: "doing", position: 0 });
  h.queue.enqueue({ cardId: second.id, columnId: "done", position: 4 });
  assert.equal(h.requests.length, 1);
  assert.equal(h.queue.snapshot().detail.cards[1].columnId, "done");
  h.acknowledge(0); await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.expectedBoardRevision, 11);
  assert.equal(h.requests[1].body.expectedRevision, 7);
  assert.equal(h.queue.snapshot().detail.cards[1].columnId, "done");
  h.acknowledge(1); await flush();
  assert.equal(h.queue.snapshot().pending.length, 0);
  assert.equal(h.queue.snapshot().saving, false);
  assert.equal(h.queue.snapshot().detail.item.revision, 12);
});

test("three successive moves of the same card retain the last reorder while older saves finish", async () => {
  const h = harness(), cardId = h.saved().cards[0].id;
  h.queue.enqueue({ cardId, columnId: "doing", position: 0 });
  h.queue.enqueue({ cardId, columnId: "done", position: 1 });
  h.queue.enqueue({ cardId, columnId: "todo", position: -2 });
  for (let index = 0; index < 3; index++) {
    const card = h.queue.snapshot().detail.cards[0];
    assert.equal(card.columnId, "todo"); assert.equal(card.position, -2);
    assert.equal(h.requests[index].body.expectedRevision, 3 + index);
    h.acknowledge(index); await flush();
  }
  assert.equal(h.queue.snapshot().detail.cards[0].revision, 6);
});

test("successive within-column reorders keep the latest fractional position after every acknowledgement", async () => {
  const h = harness(), cardId = h.saved().cards[0].id;
  for (const position of [2, -1, 0.5]) h.queue.enqueue({ cardId, columnId: "todo", position });
  for (let index = 0; index < 3; index++) {
    assert.equal(h.queue.snapshot().detail.cards[0].position, 0.5);
    h.acknowledge(index); await flush();
    assert.equal(h.queue.snapshot().detail.cards[0].position, 0.5);
  }
  assert.deepEqual(h.requests.map(request => request.body.position), [2, -1, 0.5]);
});

test("navigation and unmount detach listeners while original board saves finish in their own queue", async () => {
  const old = harness(), next = harness(detail("board-two"));
  let visible = "", oldNotifications = 0;
  const detach = old.queue.subscribe(state => { oldNotifications++; visible = state.detail.item.id; });
  old.queue.enqueue({ cardId: old.saved().cards[0].id, columnId: "doing", position: 0 });
  old.queue.enqueue({ cardId: old.saved().cards[1].id, columnId: "done", position: 0 });
  detach(); const notificationsAtNavigation = oldNotifications;
  const detachNext = next.queue.subscribe(state => { visible = state.detail.item.id; });
  old.acknowledge(0); await flush(); old.acknowledge(1); await flush();
  assert.equal(visible, "board-two"); assert.equal(oldNotifications, notificationsAtNavigation);
  assert.equal(next.requests.length, 0); assert.equal(next.queue.snapshot().detail.item.revision, 10);
  detachNext();
  const reattach = old.queue.subscribe(state => { visible = state.detail.item.id; });
  assert.equal(visible, "board-one"); assert.equal(old.queue.snapshot().detail.cards[1].columnId, "done"); reattach();
});

test("conflicts load authoritative state and retain all moves without silently overwriting another actor", async () => {
  const h = harness(), cardId = h.saved().cards[0].id;
  h.queue.enqueue({ cardId, columnId: "doing", position: 0 });
  h.queue.enqueue({ cardId, columnId: "done", position: 4 });
  const remote = h.saved();
  h.setSaved({ ...remote, item: { ...remote.item, revision: 14 }, cards: remote.cards.map(card => card.id === cardId ? { ...card, title: "Other actor's title", columnId: "done", position: 8, revision: 9 } : card) });
  h.requests[0].reply.reject(new Error("Board changed; refresh and retry")); await flush();
  const state = h.queue.snapshot();
  assert.equal(state.pending.length, 2); assert.equal(state.recovered, true); assert.equal(state.saving, false);
  assert.equal(state.detail.cards[0].title, "Other actor's title"); assert.equal(state.detail.cards[0].position, 8);
  assert.equal(h.requests.length, 1); assert.deepEqual(h.reads, [{ path: "planning/v1/boards/board-one", fresh: true }]);
  h.queue.retryReviewed();
  assert.equal(h.requests[1].body.expectedRevision, 9); assert.equal(h.requests[1].body.expectedBoardRevision, 14);
  assert.equal(h.queue.snapshot().detail.cards[0].position, 4);
  h.acknowledge(1); await flush(); h.acknowledge(2); await flush();
  assert.equal(h.queue.snapshot().detail.cards[0].title, "Other actor's title");
});

test("late failures after leaving a board stay isolated and recoverable when the view returns", async () => {
  const old = harness(), next = harness(detail("board-two"));
  let visible = "";
  const detach = old.queue.subscribe(state => { visible = state.detail.item.id; });
  old.queue.enqueue({ cardId: old.saved().cards[0].id, columnId: "doing", position: 0 });
  detach(); const detachNext = next.queue.subscribe(state => { visible = state.detail.item.id; });
  old.requests[0].reply.reject(new Error("late timeout")); await flush();
  assert.equal(visible, "board-two"); assert.equal(next.queue.snapshot().error, "");
  detachNext(); let retained = 0;
  const returned = old.queue.subscribe(state => { retained = state.pending.length; assert.match(state.error, /late timeout/); });
  assert.equal(retained, 1); returned();
});

test("an actor editing after recovery still causes a guarded conflict when reviewed moves are applied", async () => {
  const h = harness(), cardId = h.saved().cards[0].id;
  h.queue.enqueue({ cardId, columnId: "doing", position: 0 });
  h.requests[0].reply.reject(new Error("revision conflict")); await flush();
  assert.equal(h.queue.snapshot().recovered, true);
  // The user's review is of revision 10. Never fetch a newer revision and then
  // silently use it to force the pending write past this subsequent actor edit.
  h.setSaved({ ...h.saved(), item: { ...h.saved().item, revision: 11 } });
  h.queue.retryReviewed(); assert.equal(h.requests[1].body.expectedBoardRevision, 10);
  h.requests[1].reply.reject(new Error("revision conflict again")); await flush();
  assert.equal(h.requests.length, 2); assert.equal(h.queue.snapshot().pending.length, 1);
  assert.equal(h.queue.snapshot().detail.item.revision, 11); assert.match(h.queue.snapshot().error, /conflict again/);
});

test("failed recovery cannot retry or discard until authoritative state is loaded", async () => {
  const h = harness(), cardId = h.saved().cards[0].id;
  h.queue.enqueue({ cardId, columnId: "doing", position: 0 }); h.failReads(new Error("offline"));
  h.requests[0].reply.reject(new Error("timeout")); await flush();
  h.queue.retryReviewed(); h.queue.discardReviewed();
  assert.equal(h.requests.length, 1); assert.equal(h.queue.snapshot().pending.length, 1); assert.equal(h.queue.snapshot().recovered, false);
  h.failReads(); await h.queue.refreshFailed(); h.queue.discardReviewed();
  assert.equal(h.queue.snapshot().pending.length, 0); assert.equal(h.queue.snapshot().error, "");
  assert.equal(h.queue.snapshot().detail.cards[0].columnId, "todo");
});

test("removed destinations cannot be replayed and unrelated refresh cannot erase queued intent", async () => {
  const h = harness(), cardId = h.saved().cards[0].id;
  h.queue.enqueue({ cardId, columnId: "doing", position: 0 });
  h.queue.replaceSaved({ ...h.saved(), item: { ...h.saved().item, revision: 99 } });
  assert.equal(h.queue.snapshot().detail.item.revision, 10);
  h.setSaved({ ...h.saved(), columns: h.saved().columns.filter(column => column.id !== "doing") });
  h.requests[0].reply.reject(new Error("Column was removed")); await flush(); h.queue.retryReviewed();
  assert.equal(h.requests.length, 1); assert.match(h.queue.snapshot().error, /removed/);
  h.queue.discardReviewed(); assert.equal(h.queue.snapshot().pending.length, 0);
  assert.throws(() => h.queue.replaceSaved(detail("another-board")), /another board/);
});
