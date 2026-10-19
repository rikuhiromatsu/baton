// 会話の画面（13.4）: COO とのチャット（/・/p/:id）と、降りていくリーダーのスレッド（/p/:id/leader）
import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { COO_THREAD_ID, MEMBER_PROFILE_LABELS, TESTIDS, UI_TEXT_V2, type MemberProfile, type ProjectWithTeam, type ThreadSummary } from "@baton/shared";
import { resetThread } from "../api/messages.ts";
import { useOrg, useSidebar, useThreads } from "../api/queries.ts";
import { IconBranch, IconChat, IconChevronLeft, IconFolder, IconRefresh } from "../components/Icons.tsx";
import { TeamStrip } from "../components/Message.tsx";
import { ScreenHeader } from "../components/ScreenHeader.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { ThreadView } from "../components/ThreadView.tsx";
import { spring } from "../motion/tokens.ts";
import { useStreams } from "../state/streams.ts";

function ThreadStatus({ thread }: { thread: ThreadSummary | undefined }) {
  const live = useStreams((s) => (thread ? Object.values(s.byId).find((x) => x.threadId === thread.id)?.activity : null));
  if (!thread) return null;
  const activity = thread.status === "running" ? (live ?? thread.activity ?? UI_TEXT_V2.conversation.thinking) : null;
  return (
    <AnimatePresence mode="wait" initial={false}>
      {activity ? (
        <motion.span key={`a-${activity}`} className="thread-status thread-status--running" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={spring.gentle}>
          <span className="mini-typing" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{activity}</span>
        </motion.span>
      ) : thread.awaitingReply ? (
        <motion.span key="await" className="thread-status thread-status--awaiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          {UI_TEXT_V2.sidebar.awaitingReply}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

function NewTopicButton({ threadId }: { threadId: string }) {
  const qc = useQueryClient();
  return (
    <button type="button" className="header-button header-button--icon" data-testid={TESTIDS.newTopic} aria-label={UI_TEXT_V2.notices.newTopic} onClick={() => void resetThread(qc, threadId)}>
      <IconRefresh size={18} />
    </button>
  );
}

/** プロジェクトを選んだホームの帯（目的・作業場所・チーム・リーダーと話す。13.2） */
function ProjectBand({ project }: { project: ProjectWithTeam }) {
  const members = project.agents.filter((a) => a.role === "member");
  const leader = project.agents.find((a) => a.role === "leader");
  return (
    <motion.div className="project-band glass glass--card" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle}>
      <div className="project-band__main">
        <div className="project-band__name">{project.name}</div>
        {project.goal && <p className="project-band__goal">{project.goal}</p>}
        <div className="project-band__meta">
          <span className="ws-chip">
            {project.workspaceKind === "repo" ? <IconBranch size={13} /> : <IconFolder size={13} />}
            <span>{project.workspaceKind === "repo" ? (project.repoName ?? project.repoPath) : UI_TEXT_V2.proposal.baton}</span>
          </span>
          <span className="team-avatars" aria-hidden="true">
            {leader && <span className="team-avatars__item team-avatars__item--leader">{leader.name.charAt(0)}</span>}
            {members.map((m) => (
              <span key={m.id} className="team-avatars__item team-avatars__item--member" title={m.profile && m.profile in MEMBER_PROFILE_LABELS ? MEMBER_PROFILE_LABELS[m.profile as MemberProfile] : undefined}>
                {m.name.charAt(0)}
              </span>
            ))}
          </span>
        </div>
      </div>
      <Link to="/p/$projectId/leader" params={{ projectId: project.id }} className="primary-chip" data-testid={TESTIDS.leaderLink}>
        <IconChat size={15} />
        <span>{UI_TEXT_V2.conversation.talkToLeader}</span>
      </Link>
    </motion.div>
  );
}

export function CooScreen({ projectId }: { projectId: string | null }) {
  const threads = useThreads();
  const sidebar = useSidebar();
  const thread = threads.data?.items.find((t) => t.id === COO_THREAD_ID);
  const project = projectId ? sidebar.data?.items.find((i) => i.project.id === projectId)?.project : undefined;
  return (
    <div className="screen screen--thread screen--coo">
      <ScreenHeader
        title={
          <span className="thread-title">
            <span className="role-dot role-dot--coo role-dot--lg" aria-hidden="true" />
            <span>{UI_TEXT_V2.roles.coo}</span>
          </span>
        }
        sub={<ThreadStatus thread={thread} />}
        actions={<NewTopicButton threadId={COO_THREAD_ID} />}
      />
      <ThreadView threadId={COO_THREAD_ID} kind="coo" projectId={null} header={project ? <ProjectBand project={project} /> : null} />
    </div>
  );
}

export function LeaderScreen({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const org = useOrg();
  const item = sidebar.data?.items.find((i) => i.project.id === projectId);
  const threads = useThreads();
  const thread = item ? (threads.data?.items.find((t) => t.id === item.leaderThread.id) ?? item.leaderThread) : undefined;
  const team = useMemo(() => {
    const p = org.data?.projects.find((x) => x.project.id === projectId);
    if (!p) return (item?.project.agents ?? []).filter((a) => a.role === "member").map((a) => ({ id: a.id, name: a.name, state: "idle", to: null }));
    return p.members.map((m) => {
      const w = m.work[0];
      return { id: m.agent.id, name: m.agent.name, state: m.state, to: w && w.instructionId ? { instructionId: w.instructionId, sessionId: w.sessionId } : null };
    });
  }, [org.data, projectId, item]);

  return (
    <div className="screen screen--thread screen--leader">
      <ScreenHeader
        cards={true}
        leading={
          <button type="button" className="back-button back-button--coo" data-testid={TESTIDS.backToCoo} onClick={() => void navigate({ to: "/" })}>
            <span className="back-button__label">{UI_TEXT_V2.conversation.backToCoo}</span>
          </button>
        }
        title={
          <span className="thread-title">
            <span className="role-dot role-dot--leader role-dot--lg" aria-hidden="true" />
            <span>{UI_TEXT_V2.roles.leader}</span>
            {item && (
              <>
                <span className="thread-title__sep" aria-hidden="true">
                  ·
                </span>
                <span className="thread-title__project">{item.project.name}</span>
              </>
            )}
          </span>
        }
        sub={
          <span className="leader-sub">
            <span className="leader-sub__report">{UI_TEXT_V2.conversation.reportedToCoo}</span>
            <ThreadStatus thread={thread} />
          </span>
        }
        actions={thread ? <NewTopicButton threadId={thread.id} /> : null}
      />
      {team.length > 0 && <TeamStrip members={team} />}
      {item ? <ThreadView threadId={item.leaderThread.id} kind="leader" projectId={projectId} /> : <SkeletonScreen variant="thread" />}
    </div>
  );
}

export { IconChevronLeft };
