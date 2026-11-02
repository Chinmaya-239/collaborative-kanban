import { useMemo, useState } from 'react';
import { closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TaskCard, { CardBody } from './TaskCard.jsx';
import { isOverdue } from '../util.js';

function Column({ column, tasks, members, doneIds, onOpen, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
  return (
    <section className={`col ${isOver ? 'over' : ''}`} aria-label={column.name}>
      <header><h3>{column.name}</h3><span className="count">{tasks.length}</span></header>
      <div className="col-body" ref={setNodeRef}>
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => <TaskCard key={t.id} task={t} assignee={members[t.assignedTo]} overdue={isOverdue(t, doneIds)} onOpen={onOpen} />)}
        </SortableContext>
        {!tasks.length && <div className="empty">Drop a task here</div>}
      </div>
      <button className="add" onClick={() => onAdd(column.id)}>+ Add task</button>
    </section>
  );
}

export default function Board({ columns, byColumn, tasks, members, onMove, onOpen, onAdd }) {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), // a click opens the task, a drag moves it
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const doneIds = useMemo(() => new Set(columns.filter((c) => c.name === 'Done').map((c) => c.id)), [columns]);
  const active = tasks.find((t) => t.id === activeId);

  function onDragEnd({ active: a, over }) {
    setActiveId(null);
    if (!over) return;
    const task = tasks.find((t) => t.id === a.id);
    if (!task) return;
    let toCol, index;
    if (String(over.id).startsWith('col:')) {
      toCol = String(over.id).slice(4);
      index = (byColumn[toCol] || []).filter((t) => t.id !== task.id).length; // end of column
    } else {
      const overTask = tasks.find((t) => t.id === over.id);
      if (!overTask) return;
      toCol = overTask.columnId;
      index = byColumn[toCol].findIndex((t) => t.id === over.id); // final index among the OTHER tasks
    }
    if (toCol === task.columnId && index === byColumn[toCol].findIndex((t) => t.id === task.id)) return;
    onMove(task.id, toCol, index);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={(e) => setActiveId(e.active.id)} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="cols">
        {columns.map((c) => <Column key={c.id} column={c} tasks={byColumn[c.id] || []} members={members} doneIds={doneIds} onOpen={onOpen} onAdd={onAdd} />)}
      </div>
      <DragOverlay>{active ? <div className="card overlay"><CardBody task={active} assignee={members[active.assignedTo]} overdue={isOverdue(active, doneIds)} /></div> : null}</DragOverlay>
    </DndContext>
  );
}
