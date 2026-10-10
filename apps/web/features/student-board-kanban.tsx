import { useEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragOverEvent, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckCheck, GripVertical, MoreHorizontal, Plus } from "lucide-react";
import type { Row } from "../lib/api";
import { deadlineTime } from "./student-board-card";
import { positionBetween, keyboardTaskStep } from "../lib/kanban-order";

const sorted = (cards: Row[], columnId: string) => cards.filter(card => card.columnId === columnId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
export function StudentBoardKanban({ columns, cards, canWrite, canManage, busy, structureBusy = false, onMove, onEdit, onAdd, onColumn }: { columns: Row[]; cards: Row[]; canWrite: boolean; canManage: boolean; busy: boolean; structureBusy?: boolean; onMove: (card: Row, columnId: string, position: number) => Promise<void>; onEdit: (card: Row) => void; onAdd: (column: Row, position: number) => void; onColumn: (column: Row) => void }) {
  const [activeId, setActiveId] = useState<string | null>(null), [preview, setPreview] = useState<Row[]>(cards);
  useEffect(() => { if (!activeId) setPreview(cards); }, [cards, activeId]);
  const previewRef = useRef(preview); previewRef.current = preview;
  const suppressClickUntil = useRef(0);
  const keyboardTarget = useRef<{columnId: string; targetId: string} | null>(null);
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) return;
    event.preventDefault();
    const step = keyboardTaskStep(previewRef.current as (Row & {id: string; columnId: string; position: number})[], columns as (Row & {id: string})[], String(context.active?.id), event.code);
    if (!step) return;
    keyboardTarget.current = step;
    previewRef.current = step.cards; setPreview(step.cards);
    requestAnimationFrame(() => document.getElementById(`planning-handle-${context.active?.id}`)?.focus({preventScroll: true}));
    const rect = context.droppableRects.get(step.targetId);
    if (rect) return {x: rect.left + (step.targetId === step.columnId ? 12 : 0), y: rect.top + (step.targetId === step.columnId ? 53 : 1)};
  };
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: "auto" }));
  const activeCard = cards.find(card => card.id === activeId);
  const collisions: CollisionDetection = args => {
    if (!args.pointerCoordinates && keyboardTarget.current) return [{id: keyboardTarget.current.targetId}];
    const hits = pointerWithin(args), candidates = hits.length ? hits : rectIntersection(args);
    const hit = candidates[0];
    if (hit && columns.some(column => column.id === hit.id)) {
      const children = preview.filter(card => card.columnId === hit.id && card.id !== activeId);
      if (children.length) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(item => children.some(card => card.id === item.id)) });
    }
    return candidates.length ? candidates : closestCenter(args);
  };
  function over(event: DragOverEvent) {
    if (!event.over) return;
    const id = String(event.active.id), targetId = String(event.over.id);
    setPreview(current => {
      const card = current.find(item => item.id === id), target = current.find(item => item.id === targetId), columnId = target?.columnId ?? columns.find(column => column.id === targetId)?.id;
      if (!card || !columnId || card.columnId === columnId) return current;
      const siblings = sorted(current.filter(item => item.id !== id), columnId);
      let at = target ? siblings.findIndex(item => item.id === target.id) : siblings.length;
      if (target && event.active.rect.current.translated && event.active.rect.current.translated.top > event.over!.rect.top + event.over!.rect.height / 2) at++;
      return current.map(item => item.id === id ? { ...item, columnId, position: positionBetween(siblings[at - 1]?.position, siblings[at]?.position) } : item);
    });
  }
  function end(event: DragEndEvent) {
    suppressClickUntil.current = Date.now() + 350;
    const rows = previewRef.current, keyboard = event.activatorEvent instanceof KeyboardEvent;
    const targetId = keyboard ? keyboardTarget.current?.targetId ?? event.over?.id : event.over?.id;
    const original = cards.find(card => card.id === event.active.id), current = rows.find(card => card.id === event.active.id);
    if (!original || !current || !targetId) { setActiveId(null); setPreview(cards); return; }
    const target = rows.find(card => card.id === targetId), columnId = keyboard ? current.columnId : target?.columnId ?? columns.find(column => column.id === targetId)?.id ?? current.columnId;
    let order = sorted(rows, columnId);
    const index = order.findIndex(card => card.id === current.id), targetIndex = target ? order.findIndex(card => card.id === target.id) : order.length - 1;
    // Cross-column insertion is previewed during dragging; within-column sorting
    // uses the final drop target. Cancelled drags never reach the persistence API.
    if (!keyboard && original.columnId === current.columnId && index >= 0 && targetIndex >= 0) order = arrayMove(order, index, targetIndex);
    const at = order.findIndex(card => card.id === current.id), before = order[at - 1], after = order[at + 1];
    const position = positionBetween(before?.position, after?.position);
    keyboardTarget.current = null; setActiveId(null);
    if (original.columnId === columnId && sorted(cards, columnId).findIndex(card => card.id === original.id) === at) { setPreview(cards); return; }
    void onMove(original, columnId, position).finally(() => {
      if (event.activatorEvent instanceof KeyboardEvent) document.getElementById(`planning-handle-${original.id}`)?.focus({ preventScroll: true });
    });
  }
  return <DndContext sensors={sensors} collisionDetection={collisions} onDragStart={event => { suppressClickUntil.current = Infinity; keyboardTarget.current = null; previewRef.current = cards; setPreview(cards); setActiveId(String(event.active.id)); }} onDragOver={over} onDragEnd={end} onDragCancel={() => { suppressClickUntil.current = Date.now() + 350; keyboardTarget.current = null; setActiveId(null); setPreview(cards); }} accessibility={{ announcements: {
      onDragStart: ({ active }) => `Picked up ${cards.find(card => card.id === active.id)?.title ?? "task"}.`,
      onDragOver: ({ active, over }) => { const rows = previewRef.current, target = rows.find(card => card.id === over?.id), column = columns.find(item => item.id === (target?.columnId ?? over?.id)); return column ? `${rows.find(card => card.id === active.id)?.title ?? "Task"}, over ${column.name}.` : undefined; },
      onDragEnd: ({ active }) => `${cards.find(card => card.id === active.id)?.title ?? "Task"} dropped.`,
      onDragCancel: () => "Move cancelled. The task is unchanged.",
    }, screenReaderInstructions: { draggable: "Press Space to pick up a task. Use arrow keys to move it, Space to drop, and Escape to cancel." } }}>
    <div className="student-board-kanban" onClickCapture={event => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }} data-dragging={!!activeId} aria-label="Planning board columns">{columns.map((column, index) => <Column key={column.id} column={column} index={index} items={sorted(preview, column.id)} canManage={canManage} canWrite={canWrite} busy={busy || structureBusy} onColumn={onColumn} onAdd={onAdd}>
      {sorted(preview, column.id).map(card => <Task key={card.id} card={card} columns={columns} canWrite={canWrite} busy={busy} onEdit={onEdit} onMove={onMove} cards={cards} />)}
    </Column>)}</div>
    <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>{activeCard ? <article className="student-board-card planning-drag-overlay"><TaskContent card={activeCard} /></article> : null}</DragOverlay>
  </DndContext>;
}
function Column({ column, index, items, canManage, canWrite, busy, children, onColumn, onAdd }: { column: Row; index: number; items: Row[]; canManage: boolean; canWrite: boolean; busy: boolean; children: ReactNode; onColumn: (column: Row) => void; onAdd: (column: Row, position: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return <section ref={setNodeRef} className={`student-board-column${isOver ? " is-over" : ""}`} aria-label={column.name}><div className="student-board-column-heading"><span className={`planning-column-dot tone-${index % 4}`} /><h3>{column.name}</h3><span className="planning-column-count">{items.length}</span>{canManage && <button className="planning-icon-button" disabled={busy} aria-label={`Edit ${column.name} column`} onClick={() => onColumn(column)}><MoreHorizontal size={17} /></button>}</div><SortableContext items={items.map(card => card.id)} strategy={verticalListSortingStrategy}><div className="planning-column-tasks">{children}{!items.length && <div className="planning-drop-hint">Drop a task here</div>}</div></SortableContext>{canWrite && <button className="planning-add-task" disabled={busy} onClick={() => onAdd(column, items.length ? Math.max(...items.map(card => card.position)) + 1 : 0)}><Plus size={15} /> Add task</button>}</section>;
}
function Task({ card, columns, canWrite, busy, cards, onEdit, onMove }: { card: Row; columns: Row[]; canWrite: boolean; busy: boolean; cards: Row[]; onEdit: (card: Row) => void; onMove: (card: Row, columnId: string, position: number) => Promise<void> }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, disabled: !canWrite || busy });
  const dragFromCard = (target: EventTarget | null) => target instanceof Element && !target.closest(".planning-card-tools, a, input, select, textarea, summary, [contenteditable], [data-no-drag], button:not(.student-board-card-open)");
  return <article ref={setNodeRef} className={`student-board-card${canWrite ? " is-grabbable" : ""}${isDragging ? " is-dragging" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}
    onMouseDown={event => { if (dragFromCard(event.target)) listeners?.onMouseDown?.(event); }}
    onTouchStart={event => { if (dragFromCard(event.target)) listeners?.onTouchStart?.(event); }}
    onClick={event => { if (!busy && event.target instanceof Element && !event.target.closest("button, a, input, select, textarea, summary, .planning-card-tools")) onEdit(card); }}>
    <button className="student-board-card-open" disabled={busy} onClick={() => onEdit(card)}><TaskContent card={card} /></button>{canWrite && <div className="planning-card-tools"><button id={`planning-handle-${card.id}`} ref={setActivatorNodeRef} className="planning-drag-handle planning-icon-button" disabled={busy} {...attributes} {...listeners} aria-label={`Drag ${card.title}`}><GripVertical size={16} /></button><details className="planning-move-menu"><summary aria-label={`Move ${card.title}`}><MoreHorizontal size={16} /></summary><label>Move to<select disabled={busy} value={card.columnId} onChange={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void onMove(card, event.target.value, Math.max(-1, ...cards.filter(row => row.columnId === event.target.value).map(row => row.position)) + 1); }}>{columns.map(column => <option value={column.id} key={column.id}>{column.name}</option>)}</select></label></details></div>}
  </article>;
}
function TaskContent({ card }: { card: Row }) {
  const complete = card.checklist?.filter((item: Row) => item.done).length ?? 0;
  return <><strong>{card.title}</strong>{card.deadline && <span className={`planning-deadline-pill${card.deadline.dueAt ? "" : " needs-date"}`}>{card.deadline.dueAt ? `${deadlineTime(card.deadline)}${card.deadline.status === "requires_confirmation" ? " · Confirm date" : ""}` : "Date to confirm"}</span>}{card.checklist?.length > 0 && <small className="planning-task-checklist"><CheckCheck size={13} /> {complete} / {card.checklist.length}</small>}</>;
}
