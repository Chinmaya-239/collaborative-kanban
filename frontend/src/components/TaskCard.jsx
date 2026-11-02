import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { initials } from '../util.js';

export function CardBody({ task, assignee, overdue }) {
  return (
    <>
      <div className="card-title">{task.title}</div>
      {task.description && <div className="card-desc">{task.description}</div>}
      <div className="card-meta">
        <span className={`prio ${task.priority.toLowerCase()}`}>{task.priority.toLowerCase()}</span>
        {task.dueDate && <span className={overdue ? 'due overdue' : 'due'}>{overdue ? 'Overdue · ' : 'Due '}{new Date(task.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>}
        {assignee && <span className="avatar sm" title={assignee.name}>{initials(assignee.name)}</span>}
      </div>
    </>
  );
}

export default function TaskCard({ task, assignee, overdue, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      className={`card ${isDragging ? 'ghosted' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      {...attributes}
      {...listeners}
    >
      <CardBody task={task} assignee={assignee} overdue={overdue} />
    </div>
  );
}
