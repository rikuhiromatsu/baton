// 組織図（/org。13.9・D-57）。CEO → COO → プロジェクトごとのリーダー → メンバー。リアルタイムで状態が動く。
// ≥1024px は上から下の木（プロジェクトの列は横スクロール）、<1024px は縦の入れ子（プロジェクトごとに折りたたみ）
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AGENT_STATE_LABELS,
  MEMBER_PROFILE_LABELS,
  TESTIDS,
  UI_TEXT_V2,
  type AgentLive,
  type MemberProfile,
  type OrgSnapshot,
  type ProjectWithTeam,
} from "@baton/shared";
import { api } from "../api/client.ts";
import { qk } from "../api/keys.ts";
import { useOrg, useProfiles, useRepos } from "../api/queries.ts";
import { IconBranch, IconChat, IconClock, IconDots, IconFolder, IconLink, IconPlus, IconUnlink } from "../components/Icons.tsx";
import { ScreenHeader } from "../components/ScreenHeader.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { useBreakpoint } from "../lib/media.ts";
import { relativeTime } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
import { spring } from "../motion/tokens.ts";
import { toastId, useToasts } from "../state/toasts.ts";

const LONG_PRESS_MS = 520;

/** 委任の光（セッションが始まると親 → 子へ、終わると子 → 親へ緑）。状態の移り変わりから決める */
export type Spark = { kind: "down" | "up"; key: number };
export function sparkFor(prev: AgentLive["state"] | undefined, next: AgentLive["state"]): Spark["kind"] | null {
  if (prev === undefined || prev === next) return null;
  const busy = (s: AgentLive["state"]) => s === "running" || s === "awaiting_approval" || s === "talking";
  if (!busy(prev) && busy(next)) return "down";
  if (busy(prev) && (next === "idle" || next === "queued")) return "up";
  return null;
}

function useSparks(snapshot: OrgSnapshot | undefined): Record<string, Spark> {
  const prev = useRef(new Map<string, AgentLive["state"]>());
  const [sparks, setSparks] = useState<Record<string, Spark>>({});
  useEffect(() => {
    if (!snapshot) return;
    const all: AgentLive[] = [snapshot.coo, ...snapshot.projects.flatMap((p) => [...(p.leader ? [p.leader] : []), ...p.members])];
    const next: Record<string, Spark> = {};
    for (const a of all) {
      const kind = sparkFor(prev.current.get(a.agent.id), a.state);
      if (kind) next[a.agent.id] = { kind, key: Date.now() + Math.random() };
      prev.current.set(a.agent.id, a.state);
    }
    if (Object.keys(next).length > 0) setSparks((s) => ({ ...s, ...next }));
  }, [snapshot]);
  return sparks;
}

function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLong();
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        fired.current = true;
        onLong();
      },
    },
  };
}

function Node({ live, unread, onOpen, onLong, spark, compact = false }: { live: AgentLive; unread?: number; onOpen: () => void; onLong: () => void; spark?: Spark; compact?: boolean }) {
  const now = useNow();
  const lp = useLongPress(onLong);
  const a = live.agent;
  const work = live.work[0];
  const profile = a.profile && a.profile in MEMBER_PROFILE_LABELS ? MEMBER_PROFILE_LABELS[a.profile as MemberProfile] : null;
  return (
    <motion.button
      type="button"
      layout="position"
      className={`org-node org-node--${a.role} org-node--${live.state} ${compact ? "org-node--compact" : ""}`}
      data-testid={TESTIDS.orgNode}
      data-agent-id={a.id}
      data-role={a.role}
      data-state={live.state}
      aria-label={a.name}
      transition={spring.smooth}
      {...lp.handlers}
      onClick={() => {
        if (lp.fired.current) {
          lp.fired.current = false;
          return;
        }
        onOpen();
      }}
    >
      <span className="org-node__ring" aria-hidden="true" />
      {spark && <span key={spark.key} className={`org-spark org-spark--${spark.kind}`} aria-hidden="true" />}
      <span className={`org-node__avatar org-node__avatar--${a.role}`} aria-hidden="true">
        {a.role === "coo" ? "C" : a.name.charAt(0)}
        {live.state === "quota_wait" && (
          <span className="org-node__clock">
            <IconClock size={11} />
          </span>
        )}
      </span>
      <span className="org-node__body">
        <span className="org-node__name">
          <span>{a.role === "coo" ? UI_TEXT_V2.roles.coo : a.name}</span>
          {a.role === "leader" && <span className="org-node__role">{UI_TEXT_V2.roles.leader}</span>}
          {profile && <span className="org-node__role">{profile}</span>}
        </span>
        <span className="org-node__state">
          <span className={`state-dot state-dot--${live.state}`} aria-hidden="true" />
          <motion.span key={live.state} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle}>
            {AGENT_STATE_LABELS[live.state]}
          </motion.span>
          {live.state === "idle" && live.lastActiveAt && <span className="org-node__ago">{relativeTime(live.lastActiveAt, now)}</span>}
        </span>
        {work && (
          <span className="org-node__work">
            <span className="org-node__work-title">{work.title}</span>
            {work.activity && (
              <motion.span key={work.activity} className="org-node__activity" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                {work.activity}
              </motion.span>
            )}
          </span>
        )}
      </span>
      {(unread ?? 0) > 0 && <span className="badge org-node__badge">{unread}</span>}
    </motion.button>
  );
}

function CeoNode() {
  return (
    <div className="org-node org-node--ceo" aria-hidden="false">
      <span className="org-node__avatar org-node__avatar--ceo">
        <span>{UI_TEXT_V2.roles.ceo}</span>
      </span>
    </div>
  );
}

type ProjectEntry = OrgSnapshot["projects"][number];

function ProjectBand({ entry, onOpen, onMore, collapsed }: { entry: ProjectEntry; onOpen: () => void; onMore?: () => void; collapsed?: boolean }) {
  const p = entry.project;
  const c = entry.counts;
  const total = c.running + c.queued + c.needsDecision + c.review;
  return (
    <div className="org-project glass glass--card" data-collapsed={collapsed ? "true" : "false"}>
      <button type="button" className="org-project__main" data-testid={TESTIDS.orgProject} aria-expanded={collapsed === undefined ? undefined : !collapsed} onClick={onOpen}>
        <span className="org-project__name">
          {p.workspaceKind === "repo" ? <IconBranch size={13} /> : <IconFolder size={13} />}
          <span>{p.name}</span>
        </span>
        {p.goal && <span className="org-project__goal">{p.goal}</span>}
        <span className="org-project__counts">
          {c.needsDecision > 0 && <span className="count-chip count-chip--needs_decision">{c.needsDecision}</span>}
          {c.review > 0 && <span className="count-chip count-chip--review">{c.review}</span>}
          {c.running > 0 && <span className="count-chip count-chip--running">{c.running}</span>}
          {total > 0 && (
            <span className="org-project__total">
              <span className="num">{total}</span>
              <span>{UI_TEXT_V2.org.count}</span>
            </span>
          )}
        </span>
      </button>
      {onMore && (
        <button type="button" className="icon-button org-project__more" aria-label={p.name} onClick={onMore}>
          <IconDots size={16} />
        </button>
      )}
    </div>
  );
}

function AgentSheet({ live, onClose }: { live: AgentLive | null; onClose: () => void }) {
  const profiles = useProfiles(live !== null);
  const pid = live?.agent.profile ?? (live?.agent.role === "coo" ? "coo" : live?.agent.role === "leader" ? "leader" : "generalist");
  const profile = profiles.data?.items.find((x) => x.id === pid);
  const label = pid && pid in MEMBER_PROFILE_LABELS ? MEMBER_PROFILE_LABELS[pid as MemberProfile] : live?.agent.role === "leader" ? UI_TEXT_V2.roles.leader : UI_TEXT_V2.roles.coo;
  return (
    <Sheet open={live !== null} onClose={onClose} testId={TESTIDS.agentSheet} label={live?.agent.name} title={live ? <span className="sheet-title">{live.agent.role === "coo" ? UI_TEXT_V2.roles.coo : live.agent.name}</span> : null}>
      {live && (
        <div className="agent-sheet">
          {live.agent.specialty && <p className="agent-sheet__specialty">{live.agent.specialty}</p>}
          <dl className="kv">
            <dt>{UI_TEXT_V2.org.profile}</dt>
            <dd>
              <span className="pill">{label}</span>
              {profile && <code className="kv__code">{profile.model}</code>}
            </dd>
            <dt>{UI_TEXT_V2.org.skills}</dt>
            <dd className="chips">
              {(profile?.skills ?? []).length === 0 ? <span className="muted">-</span> : profile!.skills.map((s) => <code key={s} className="chip-code">{s}</code>)}
            </dd>
            <dt>{UI_TEXT_V2.org.tools}</dt>
            <dd className="chips">
              {(profile?.tools ?? []).map((t) => (
                <code key={t} className="chip-code">
                  {t}
                </code>
              ))}
            </dd>
          </dl>
        </div>
      )}
    </Sheet>
  );
}

function ProjectSheet({ project, onClose }: { project: ProjectWithTeam | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const repos = useRepos(project !== null);
  useEffect(() => setPicking(false), [project?.id]);
  const patch = async (repoPath: string | null) => {
    if (!project) return;
    try {
      await api.patchProject(project.id, { repoPath });
      void qc.invalidateQueries({ queryKey: qk.org });
      void qc.invalidateQueries({ queryKey: qk.sidebar });
      setPicking(false);
    } catch {
      useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    }
  };
  return (
    <Sheet open={project !== null} onClose={onClose} testId={TESTIDS.projectSheet} label={project?.name} title={project ? <span className="sheet-title">{project.name}</span> : null}>
      {project && (
        <div className="project-sheet">
          <section className="proposal__section">
            <h4 className="proposal__label">{UI_TEXT_V2.proposal.goal}</h4>
            <p className="proposal__goal">{project.goal || "-"}</p>
          </section>
          <section className="proposal__section">
            <h4 className="proposal__label">{UI_TEXT_V2.proposal.workspace}</h4>
            <div className="project-sheet__ws">
              <span className="ws-chip">
                {project.workspaceKind === "repo" ? <IconBranch size={13} /> : <IconFolder size={13} />}
                <span>{project.workspaceKind === "repo" ? project.repoName : UI_TEXT_V2.proposal.baton}</span>
              </span>
              {project.workspaceKind === "repo" ? (
                <button type="button" className="ghost-button" data-testid={TESTIDS.repoUnlinkButton} onClick={() => void patch(null)}>
                  <IconUnlink size={14} />
                  <span>{UI_TEXT_V2.org.unlinkRepo}</span>
                </button>
              ) : (
                <button type="button" className="ghost-button" data-testid={TESTIDS.repoLinkButton} onClick={() => setPicking((v) => !v)}>
                  <IconLink size={14} />
                  <span>{UI_TEXT_V2.org.linkRepo}</span>
                </button>
              )}
            </div>
            <AnimatePresence initial={false}>
              {picking && (
                <motion.ul className="repo-options" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
                  {(repos.data?.items ?? [])
                    .filter((r) => !r.projectId)
                    .map((r) => (
                      <li key={r.path}>
                        <button type="button" className="repo-option" data-testid={TESTIDS.repoOption} data-path={r.path} onClick={() => void patch(r.path)}>
                          <IconBranch size={14} />
                          <span className="repo-option__name">{r.name}</span>
                          {r.dirty && <span className="repo-option__dirty">{UI_TEXT_V2.proposal.dirty}</span>}
                        </button>
                      </li>
                    ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </section>
          <section className="proposal__section">
            <h4 className="proposal__label">{UI_TEXT_V2.proposal.team}</h4>
            <ul className="proposal__team">
              {project.agents.map((a) => (
                <li key={a.id} className="proposal__agent">
                  <span className={`role-dot role-dot--${a.role}`} aria-hidden="true" />
                  <span className="proposal__agent-name">{a.name}</span>
                  <span className="proposal__agent-role">{a.role === "leader" ? UI_TEXT_V2.roles.leader : a.profile && a.profile in MEMBER_PROFILE_LABELS ? MEMBER_PROFILE_LABELS[a.profile as MemberProfile] : UI_TEXT_V2.roles.member}</span>
                </li>
              ))}
            </ul>
          </section>
          <div className="proposal__actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                onClose();
                void navigate({ to: "/p/$projectId/leader", params: { projectId: project.id } });
              }}
            >
              <IconChat size={15} />
              <span>{UI_TEXT_V2.conversation.talkToLeader}</span>
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                onClose();
                void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
              }}
            >
              {UI_TEXT_V2.org.viewInstructions}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function CreateFromRepoSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const repos = useRepos(open);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = async (repoPath: string) => {
    try {
      await api.createProjectFromRepo(repoPath);
      void qc.invalidateQueries({ queryKey: qk.messages("thread-coo") });
      onClose();
      void navigate({ to: "/" });
    } catch {
      useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    }
  };
  return (
    <Sheet open={open} onClose={onClose} label={UI_TEXT_V2.org.createFromRepo} title={<span className="sheet-title">{UI_TEXT_V2.org.createFromRepo}</span>}>
      <ul className="repo-options repo-options--sheet">
        {(repos.data?.items ?? [])
          .filter((r) => !r.projectId)
          .map((r) => (
            <li key={r.path}>
              <button type="button" className="repo-option" data-testid={TESTIDS.repoOption} data-path={r.path} onClick={() => void create(r.path)}>
                <IconBranch size={14} />
                <span className="repo-option__name">{r.name}</span>
                {r.dirty && <span className="repo-option__dirty">{UI_TEXT_V2.proposal.dirty}</span>}
              </button>
            </li>
          ))}
      </ul>
    </Sheet>
  );
}

export function OrgScreen() {
  const org = useOrg();
  const bp = useBreakpoint();
  const navigate = useNavigate();
  const sparks = useSparks(org.data);
  const [agentSheet, setAgentSheet] = useState<AgentLive | null>(null);
  const [projectSheet, setProjectSheet] = useState<ProjectWithTeam | null>(null);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [workPicker, setWorkPicker] = useState<AgentLive | null>(null);
  const tree = bp !== "narrow";
  const s = org.data;

  const openMember = (m: AgentLive) => {
    const work = m.work.filter((w) => w.instructionId);
    if (work.length === 1) void navigate({ to: "/i/$id", params: { id: work[0]!.instructionId! }, search: { s: work[0]!.sessionId } });
    else if (work.length > 1) setWorkPicker(m);
    else setAgentSheet(m);
  };

  const leaderNode = (e: ProjectEntry) =>
    e.leader && (
      <Node
        live={e.leader}
        unread={undefined}
        spark={sparks[e.leader.agent.id]}
        onOpen={() => void navigate({ to: "/p/$projectId/leader", params: { projectId: e.project.id } })}
        onLong={() => setAgentSheet(e.leader)}
      />
    );

  return (
    <div className="screen screen--org">
      <ScreenHeader
        cards={false}
        title={<span className="thread-title">{UI_TEXT_V2.sidebar.org}</span>}
        actions={
          <button type="button" className="header-button" data-testid={TESTIDS.repoCreateButton} onClick={() => setCreating(true)}>
            <IconPlus size={17} />
            <span className="header-button__label">{UI_TEXT_V2.org.createFromRepo}</span>
          </button>
        }
      />
      <div className="org-scroll">
        {!s ? (
          <SkeletonScreen variant="org" />
        ) : (
          <div className={`org-chart ${tree ? "org-chart--tree" : "org-chart--stack"}`} data-testid={TESTIDS.orgChart}>
            <div className="org-top">
              <CeoNode />
              <span className="org-stem" aria-hidden="true" />
              <Node live={s.coo} unread={s.coo.thread.unread} spark={sparks[s.coo.agent.id]} onOpen={() => void navigate({ to: "/" })} onLong={() => setAgentSheet(s.coo)} />
            </div>
            {tree ? (
              <div className="org-columns-wrap">
                <span className="org-stem org-stem--to-bus" aria-hidden="true" />
                <div className="org-columns">
                  {s.projects.map((e, i) => {
                    const talking = e.leader?.state === "talking";
                    return (
                      <motion.div key={e.project.id} className={`org-col ${talking ? "org-col--talking" : ""}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.gentle, delay: i * 0.05 }}>
                        <span className="org-col__bus" aria-hidden="true" />
                        <span className="org-col__stem" aria-hidden="true" />
                        <ProjectBand entry={e} onOpen={() => setProjectSheet(e.project)} />
                        <span className="org-col__stem org-col__stem--short" aria-hidden="true" />
                        {leaderNode(e)}
                        <div className="org-members">
                          {e.members.map((m) => (
                            <div key={m.agent.id} className="org-member">
                              <span className="org-member__stem" aria-hidden="true">
                                {sparks[m.agent.id] && <span key={sparks[m.agent.id]!.key} className={`org-spark org-spark--${sparks[m.agent.id]!.kind}`} />}
                              </span>
                              <Node live={m} onOpen={() => openMember(m)} onLong={() => setAgentSheet(m)} />
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="org-stack">
                {s.projects.map((e) => {
                  const isCollapsed = collapsed[e.project.id] ?? false;
                  return (
                    <div key={e.project.id} className="org-stack__project">
                      <ProjectBand entry={e} collapsed={isCollapsed} onOpen={() => setCollapsed((c) => ({ ...c, [e.project.id]: !isCollapsed }))} onMore={() => setProjectSheet(e.project)} />
                      <AnimatePresence initial={false}>
                        {!isCollapsed && (
                          <motion.div className="org-stack__team" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
                            {leaderNode(e)}
                            <div className="org-stack__members">
                              {e.members.map((m) => (
                                <Node key={m.agent.id} live={m} compact spark={sparks[m.agent.id]} onOpen={() => openMember(m)} onLong={() => setAgentSheet(m)} />
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <AgentSheet live={agentSheet} onClose={() => setAgentSheet(null)} />
      <ProjectSheet project={projectSheet} onClose={() => setProjectSheet(null)} />
      <CreateFromRepoSheet open={creating} onClose={() => setCreating(false)} />
      <Sheet open={workPicker !== null} onClose={() => setWorkPicker(null)} label={workPicker?.agent.name} title={<span className="sheet-title">{workPicker?.agent.name}</span>}>
        <ul className="work-picker">
          {(workPicker?.work ?? [])
            .filter((w) => w.instructionId)
            .map((w) => (
              <li key={w.sessionId}>
                <Link to="/i/$id" params={{ id: w.instructionId! }} search={{ s: w.sessionId }} className="work-picker__item" onClick={() => setWorkPicker(null)}>
                  <span>{w.title}</span>
                  {w.activity && <span className="muted">{w.activity}</span>}
                </Link>
              </li>
            ))}
        </ul>
      </Sheet>
    </div>
  );
}
