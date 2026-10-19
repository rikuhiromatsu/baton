// 指示の詳細（13.7）。トランスクリプト中心。エージェントのタブ（COO → リーダー → メンバー）、本文のタブ
// （やりとり・TODO・変更・報告・成果物）、≥1280px は右に補助列。入力欄は MainLayout がタブに合わせて宛先を変える（D-54）
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  DETAIL_TABS,
  MEMBER_PROFILE_LABELS,
  SESSION_STATUS_LABELS,
  STATUS_LABELS,
  TESTIDS,
  UI_TEXT,
  UI_TEXT_V2,
  displayGroup,
  type AgentSessionSummary,
  type DetailTab,
  type InstructionDetail,
  type MemberProfile,
} from "@baton/shared";
import { loadOlderTranscript, useDiff, useInstructionDetail, useTranscript } from "../api/queries.ts";
import { subscribeInstruction } from "../api/ws.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { ArtifactList } from "../components/ArtifactList.tsx";
import { BranchChip, DiffView } from "../components/DiffView.tsx";
import { IconChat, IconX } from "../components/Icons.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ScreenHeader } from "../components/ScreenHeader.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { TodoCard, Transcript } from "../components/Transcript.tsx";
import { useBreakpoint } from "../lib/media.ts";
import { cardTitle, splitLimitError } from "../lib/text.ts";
import { latestTodos, type ViewMode } from "../lib/transcript-view.ts";
import { spring } from "../motion/tokens.ts";
import { outboxForSession, useOutbox } from "../state/outbox.ts";
import { useUi } from "../state/ui.ts";

const VIEW_MODE_KEY = "baton.transcriptMode";

function readMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "detailed" ? "detailed" : "standard";
  } catch {
    return "standard";
  }
}

export type AgentTab = { key: string; role: "coo" | "leader" | "member" | "legacy"; session: AgentSessionSummary | null; label: string; sub: string | null; status: string };

/** エージェントのタブを並べる（COO → リーダー → 各メンバー）。COO・リーダーはセッションが無くても出す（スレッドへの発言のため） */
export function buildAgentTabs(d: InstructionDetail): AgentTab[] {
  const latest = (role: AgentSessionSummary["role"]) =>
    d.sessions.filter((s) => s.role === role).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const agentName = (id: string | null) => d.project?.agents.find((a) => a.id === id) ?? null;
  const tabs: AgentTab[] = [];
  const coo = latest("coo");
  tabs.push({ key: "coo", role: "coo", session: coo, label: UI_TEXT_V2.roles.coo, sub: null, status: coo?.status ?? "idle" });
  if (d.leaderThreadId || d.sessions.some((s) => s.role === "leader")) {
    const leader = latest("leader");
    tabs.push({ key: "leader", role: "leader", session: leader, label: UI_TEXT_V2.roles.leader, sub: agentName(leader?.agentId ?? null)?.name ?? d.project?.agents.find((a) => a.role === "leader")?.name ?? null, status: leader?.status ?? "idle" });
  }
  for (const s of d.sessions.filter((x) => x.role === "member").sort((a, b) => a.createdAt - b.createdAt)) {
    const a = agentName(s.agentId);
    const task = d.tasks.find((t) => t.id === s.taskId);
    tabs.push({ key: s.id, role: "member", session: s, label: a?.name ?? UI_TEXT_V2.roles.member, sub: task?.title ?? null, status: s.status });
  }
  for (const s of d.sessions.filter((x) => x.role === "legacy")) tabs.push({ key: s.id, role: "legacy", session: s, label: s.title, sub: null, status: s.status });
  return tabs;
}

/** 既定のタブ: CEO の対応が要るもの → 実行中 → COO（13.7） */
export function defaultTabKey(tabs: AgentTab[], wanted: string | undefined): string {
  if (wanted) {
    const hit = tabs.find((t) => t.session?.id === wanted || t.key === wanted);
    if (hit) return hit.key;
  }
  const needs = tabs.find((t) => t.session && (t.session.status === "awaiting_approval" || t.session.status === "paused"));
  if (needs) return needs.key;
  const running = tabs.find((t) => t.role === "member" && t.session?.status === "running");
  if (running) return running.key;
  return tabs[0]?.key ?? "coo";
}

type Props = { id: string; sessionParam: string | undefined; onClose: () => void; sheet: boolean };

export function DetailScreen({ id, sessionParam, onClose, sheet }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detail = useInstructionDetail(id);
  const d = detail.data;
  const bp = useBreakpoint();
  const wide = bp === "wide";
  const [mode, setMode] = useState<ViewMode>(readMode);
  const [tab, setTab] = useState<DetailTab>("transcript");
  const tabs = useMemo(() => (d ? buildAgentTabs(d) : []), [d]);
  const activeKey = defaultTabKey(tabs, sessionParam);
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const outbox = useOutbox((s) => s.items);

  // 開いている間はその指示のトランスクリプトを購読する
  useEffect(() => {
    subscribeInstruction(id);
    return () => subscribeInstruction(null);
  }, [id]);

  // 入力欄の宛先（COO・リーダーはスレッドへの発言、メンバーは追加の依頼）
  useEffect(() => {
    if (!d || !active) return;
    if (active.role === "coo" || active.role === "legacy") useUi.getState().setDetailTarget({ instructionId: id, role: "coo", threadId: d.cooThreadId });
    else if (active.role === "leader" && d.leaderThreadId) useUi.getState().setDetailTarget({ instructionId: id, role: "leader", threadId: d.leaderThreadId, projectId: d.project?.id ?? null });
    else if (active.role === "member" && active.session) useUi.getState().setDetailTarget({ instructionId: id, role: "member", sessionId: active.session.id, running: active.session.status === "running" });
    return () => useUi.getState().setDetailTarget(null);
  }, [active, d, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUi.getState().sendBackFor && !useUi.getState().actionMenu && !(e.target as HTMLElement)?.closest?.(".sheet-modal")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const session = active?.session ?? null;
  const threadRole = active?.role === "coo" || active?.role === "leader";
  const transcript = useTranscript(qc, session?.id ?? null, threadRole ? id : null);
  const diff = useDiff(id, tab === "diff" || wide);
  const items = transcript.data?.items ?? [];
  const pending = session ? outboxForSession(outbox, session.id).map((o) => ({ id: o.clientId, body: o.body })) : [];

  const setModeSaved = (m: ViewMode) => {
    setMode(m);
    try {
      localStorage.setItem(VIEW_MODE_KEY, m);
    } catch {
      // 無視
    }
  };

  const selectTab = (t: AgentTab) => {
    // セッションの無い COO・リーダーのタブはキー（coo・leader）で覚える
    void navigate({ to: "/i/$id", params: { id }, search: { s: t.session?.id ?? t.key }, replace: true });
  };

  const inst = d?.instruction;
  const group = inst ? displayGroup(inst) : null;
  const integ = d?.workspaces.find((w) => w.purpose === "integration") ?? null;
  const taskWs = session?.workspaceId ? (d?.workspaces.find((w) => w.id === session.workspaceId) ?? null) : null;
  const batonOnly = d?.project?.workspaceKind !== "repo";
  const limit = inst?.error ? splitLimitError(inst.error) : null;
  // トランスクリプトの中に承認の項目があれば、上には重ねて出さない
  const inlineIds = new Set(tab === "transcript" ? items.filter((it) => it.kind === "approval").map((it) => String((it.body as { decisionId?: unknown }).decisionId ?? "")) : []);
  const openApprovals = (d?.openDecisions ?? []).filter((x) => x.status === "open" && !inlineIds.has(x.id) && (!session || x.sessionId === session.id || !x.sessionId));
  const otherApprovals = (d?.openDecisions ?? []).filter((x) => x.status === "open" && !inlineIds.has(x.id) && !openApprovals.includes(x));

  const todoPane = (() => {
    if (!d) return null;
    if (active?.role === "member") {
      const todos = latestTodos(items);
      return todos ? <TodoCard todos={todos} /> : <p className="empty-line">-</p>;
    }
    // リーダー・COO のタブは計画（タスクと paths）
    return (
      <ul className="plan-list todo-list" data-testid={TESTIDS.todoList}>
        {d.tasks.map((t) => {
          const who = d.project?.agents.find((a) => a.id === t.assigneeAgentId);
          return (
            <li key={t.id} className={`plan-item todo-item todo-item--${t.status === "done" ? "completed" : t.status === "running" ? "in_progress" : "pending"}`} data-testid={TESTIDS.todoItem} data-status={t.status}>
              <span className={`status-dot status-dot--${t.status === "done" ? "done" : t.status === "running" ? "running" : t.status === "failed" ? "failed" : "queued"}`} aria-hidden="true" />
              <span className="plan-item__main">
                <span className="plan-item__title">
                  <code className="plan-item__key">{t.planKey ?? ""}</code>
                  {t.title}
                </span>
                <span className="plan-item__meta">
                  {who && <span>{who.name}</span>}
                  {t.paths.map((p) => (
                    <code key={p} className="plan-item__path">
                      {p}
                    </code>
                  ))}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    );
  })();

  const reportPane = inst?.resultSummary ? (
    <div className="report-pane" data-testid={TESTIDS.reportText}>
      <Markdown text={inst.resultSummary} />
    </div>
  ) : (
    <p className="empty-line">-</p>
  );

  const content = !d ? (
    detail.isError ? <p className="empty-line">-</p> : <SkeletonScreen variant="detail" />
  ) : (
    <div className="detail__body">
      <div className="detail__main">
        <div className="agent-tabs" role="tablist">
          {tabs.map((t) => {
            const selected = t.key === activeKey;
            const profile = t.role === "member" ? d.project?.agents.find((a) => a.id === t.session?.agentId)?.profile : null;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`agent-tab agent-tab--${t.role}`}
                data-testid={TESTIDS.sessionTab}
                data-session-id={t.session?.id ?? ""}
                data-role={t.role}
                data-status={t.status}
                onClick={() => selectTab(t)}
              >
                {selected && <motion.span layoutId={`agent-tab-${id}`} className="agent-tab__bg" transition={spring.snappy} />}
                <span className={`state-dot state-dot--${t.status}`} aria-hidden="true" />
                <span className="agent-tab__label">{t.label}</span>
                {t.sub && <span className="agent-tab__sub">{t.sub}</span>}
                {profile && profile in MEMBER_PROFILE_LABELS && <span className="agent-tab__profile">{MEMBER_PROFILE_LABELS[profile as MemberProfile]}</span>}
              </button>
            );
          })}
        </div>
        <div className="body-tabs">
          <div className="segmented segmented--tabs" role="tablist">
            {DETAIL_TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className="segmented__item" data-testid={TESTIDS.detailTab(t)} onClick={() => setTab(t)}>
                {tab === t && <motion.span layoutId={`body-tab-${id}`} className="segmented__thumb" transition={spring.snappy} />}
                <span className="segmented__label">{UI_TEXT_V2.detailTabs[t]}</span>
              </button>
            ))}
          </div>
          {tab === "transcript" && (
            <div className="segmented segmented--mini" role="radiogroup" data-testid={TESTIDS.viewMode} data-value={mode}>
              {(["standard", "detailed"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className="segmented__item" onClick={() => setModeSaved(m)}>
                  {mode === m && <motion.span layoutId={`mode-${id}`} className="segmented__thumb" transition={spring.snappy} />}
                  <span className="segmented__label">{m === "standard" ? UI_TEXT_V2.detailTabs.standard : UI_TEXT_V2.detailTabs.detailed}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {(openApprovals.length > 0 || otherApprovals.length > 0) && (
          <div className="detail__approvals">
            {openApprovals.map((x) => (
              <ApprovalCard key={x.id} decision={x} />
            ))}
            {otherApprovals.map((x) => (
              <ApprovalCard key={x.id} decision={x} compact />
            ))}
          </div>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${tab}:${activeKey}`} className={`detail__pane detail__pane--${tab}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={spring.gentle}>
            {tab === "transcript" &&
              (transcript.data || !session ? (
                <Transcript
                  items={items}
                  mode={mode}
                  session={session}
                  decisions={d.decisions}
                  pending={pending}
                  hasMoreBefore={transcript.data?.hasMoreBefore ?? false}
                  onLoadOlder={() => void (session && loadOlderTranscript(qc, session.id, threadRole ? id : null))}
                />
              ) : (
                <SkeletonScreen variant="detail" />
              ))}
            {tab === "todo" && <div className="pane-scroll">{todoPane}</div>}
            {tab === "diff" && (
              <div className="pane-scroll">
                <DiffView diff={active?.role === "member" && taskWs ? { workspace: taskWs, files: taskWs.diffStat, patch: diff.data?.patch ?? null, truncated: false, reviewSummary: null } : diff.data} workspace={active?.role === "member" ? taskWs : integ} batonOnly={batonOnly} />
              </div>
            )}
            {tab === "report" && <div className="pane-scroll">{reportPane}</div>}
            {tab === "artifacts" && <div className="pane-scroll">{d.artifacts.length > 0 ? <ArtifactList artifacts={d.artifacts} /> : <p className="empty-line">-</p>}</div>}
          </motion.div>
        </AnimatePresence>
      </div>
      {wide && (
        <aside className="detail__aside">
          <section className="aside-block">
            <h3 className="aside-block__label">{UI_TEXT_V2.detailTabs.todo}</h3>
            {todoPane}
          </section>
          <section className="aside-block">
            <h3 className="aside-block__label">{UI_TEXT_V2.detailTabs.diff}</h3>
            <BranchChip workspace={integ} batonOnly={batonOnly} />
            <ul className="aside-files">
              {(diff.data?.files ?? integ?.diffStat ?? []).slice(0, 8).map((f) => (
                <li key={f.path}>
                  <span className="aside-files__path">{f.path}</span>
                  <span className="add">+{f.added}</span>
                </li>
              ))}
            </ul>
          </section>
          {inst?.resultSummary && (
            <section className="aside-block">
              <h3 className="aside-block__label">{UI_TEXT_V2.detailTabs.report}</h3>
              <div className="aside-report">
                <Markdown text={inst.resultSummary} />
              </div>
            </section>
          )}
        </aside>
      )}
    </div>
  );

  return (
    <div className={`detail ${sheet ? "detail--sheet" : "detail--pane"}`} data-testid={TESTIDS.instructionSheet} data-status={inst?.status ?? ""}>
      <ScreenHeader
        className="detail__header"
        cards={!sheet}
        leading={
          <button type="button" className={sheet ? "header-button header-button--icon" : "back-button"} data-testid={TESTIDS.sheetClose} aria-label={sheet ? UI_TEXT.close : UI_TEXT_V2.conversation.backToConversation} onClick={onClose}>
            {sheet ? <IconX size={20} /> : <span>{UI_TEXT_V2.conversation.backToConversation}</span>}
          </button>
        }
        title={
          <span className="detail__title">
            {group && <span className={`status-dot status-dot--${group}`} aria-hidden="true" />}
            <span className="detail__title-text">{inst ? cardTitle(inst) : ""}</span>
          </span>
        }
        sub={
          inst && (
            <span className="detail__meta">
              {group && <span className={`status-chip status-chip--${group}`}>{STATUS_LABELS[group]}</span>}
              {inst.projectName && <span className="detail__project">{inst.projectName}</span>}
              {d && <BranchChip workspace={integ} batonOnly={batonOnly} />}
              {inst.revision > 1 && (
                <span className="rev">
                  {UI_TEXT_V2.instruction.rev} {inst.revision}
                </span>
              )}
              {inst.costUsdEst > 0 && <span className="detail__cost num">${inst.costUsdEst.toFixed(2)}</span>}
              {active?.session && <span className="detail__session-state">{SESSION_STATUS_LABELS[active.session.status]}</span>}
              <Link to={inst.projectId ? "/p/$projectId" : "/"} params={inst.projectId ? { projectId: inst.projectId } : {}} className="detail__in-thread">
                <IconChat size={13} />
                <span>{UI_TEXT_V2.conversation.viewInConversation}</span>
              </Link>
            </span>
          )
        }
      />
      {limit && (
        <p className="detail__error">
          {limit.limit && <span className="card__error-prefix">{UI_TEXT.limitReached}</span>}
          <span>{limit.rest}</span>
        </p>
      )}
      {content}
    </div>
  );
}
