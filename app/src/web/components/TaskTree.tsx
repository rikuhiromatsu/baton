// plan → work → review の木（7.5・7.7）
import { AnimatePresence, motion } from "motion/react";
import { TESTIDS, type Agent, type Task } from "@baton/shared";
import { spring } from "../motion/tokens.ts";

function orderTasks(tasks: Task[]): { task: Task; depth: number }[] {
  const plans = tasks.filter((t) => t.kind === "plan").sort((a, b) => a.round - b.round || a.seq - b.seq);
  const out: { task: Task; depth: number }[] = [];
  const used = new Set<string>();
  for (const p of plans) {
    out.push({ task: p, depth: 0 });
    used.add(p.id);
    const children = tasks
      .filter((t) => t.parentTaskId === p.id)
      .sort((a, b) => (a.kind === b.kind ? a.seq - b.seq : a.kind === "work" ? -1 : 1));
    for (const c of children) {
      out.push({ task: c, depth: 1 });
      used.add(c.id);
    }
  }
  for (const t of tasks.filter((x) => !used.has(x.id)).sort((a, b) => a.seq - b.seq)) out.push({ task: t, depth: t.kind === "plan" ? 0 : 1 });
  return out;
}

function StatusMark({ status }: { status: Task["status"] }) {
  if (status === "done") {
    return (
      <svg className="task-mark task-mark--done" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="8" fill="var(--accent-success)" opacity="0.14" />
        <motion.path
          d="M5.2 9.4l2.4 2.4 5.2-5.6"
          fill="none"
          stroke="var(--accent-success)"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </svg>
    );
  }
  return <span className={`task-mark task-mark--${status}`} aria-hidden="true" />;
}

export function TaskTree({ tasks, agents }: { tasks: Task[]; agents: Agent[] }) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rows = orderTasks(tasks);
  return (
    <ul className="task-tree" data-testid={TESTIDS.taskTree}>
      <AnimatePresence initial={false}>
        {rows.map(({ task, depth }) => {
          const agent = task.assigneeAgentId ? byId.get(task.assigneeAgentId) : undefined;
          return (
            <motion.li
              key={task.id}
              layout="position"
              className={`task-node task-node--${task.kind}`}
              data-testid={TESTIDS.taskNode}
              data-kind={task.kind}
              data-status={task.status}
              style={{ paddingLeft: depth * 22 }}
              initial={{ x: -8, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={spring.gentle}
            >
              {depth > 0 && <span className="task-node__branch" aria-hidden="true" />}
              <StatusMark status={task.status} />
              <div className="task-node__body">
                <div className="task-node__title">{task.title}</div>
                {agent && <div className="task-node__agent">{agent.name}</div>}
                {task.resultSummary && <div className="task-node__summary">{task.resultSummary}</div>}
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
