// プロジェクトとチーム（閲覧のみ。7.2）
import { useEffect } from "react";
import { motion } from "motion/react";
import { TESTIDS, type Agent, type ProjectWithTeam } from "@baton/shared";
import { useProjects } from "../api/queries.ts";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { dismissBootSkeleton } from "../lib/boot.ts";
import { spring } from "../motion/tokens.ts";

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <li className={`agent agent--${agent.role}`}>
      <span className="agent__badge" aria-hidden="true">
        {agent.name.trim().charAt(0)}
      </span>
      <div className="agent__body">
        <div className="agent__name">{agent.name}</div>
        {agent.specialty && <div className="agent__specialty">{agent.specialty}</div>}
      </div>
    </li>
  );
}

function ProjectCard({ project, index }: { project: ProjectWithTeam; index: number }) {
  const leader = project.agents.filter((a) => a.role === "leader");
  const members = project.agents.filter((a) => a.role === "member");
  return (
    <motion.article
      className="project glass glass--card"
      data-testid={TESTIDS.projectCard}
      data-id={project.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.gentle, delay: Math.min(index, 10) * 0.03 }}
    >
      <header className="project__head">
        <h2 className="project__name">{project.name}</h2>
        <span className="project__slug">{project.slug}</span>
      </header>
      {project.summary && <p className="project__summary">{project.summary}</p>}
      <ul className="project__team">
        {leader.map((a) => (
          <AgentRow key={a.id} agent={a} />
        ))}
        {members.map((a) => (
          <AgentRow key={a.id} agent={a} />
        ))}
      </ul>
    </motion.article>
  );
}

export function Projects() {
  const q = useProjects();
  useEffect(() => dismissBootSkeleton({ immediate: !q.data }), [q.data]);
  return (
    <main className="screen screen--projects">
      {q.data ? (
        <div className="project-grid">
          {q.data.items
            .filter((p) => p.status === "active")
            .map((p, i) => (
              <ProjectCard key={p.id} project={p} index={i} />
            ))}
        </div>
      ) : (
        <SkeletonScreen variant="list" />
      )}
    </main>
  );
}
