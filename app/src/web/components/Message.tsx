// 会話の 1 発言（4.3・13.4）。CEO は右、エージェントは左に名前と役割の色。種類ごとにカード
import { memo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { STATUS_LABELS, TESTIDS, UI_TEXT, UI_TEXT_V2, displayGroup, type AuthorKind, type InstructionSummary } from "@baton/shared";
import { findInstruction } from "../api/cache.ts";
import { deliver, type DisplayMessage } from "../api/messages.ts";
import { cardTitle } from "../lib/text.ts";
import { messageTime } from "../lib/time.ts";
import { spring } from "../motion/tokens.ts";
import { useStreams } from "../state/streams.ts";
import { useUi } from "../state/ui.ts";
import { IconBranch, IconChat, IconChevronRight, IconHand } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { ProposalCard } from "./ProposalCard.tsx";

export type AuthorInfo = { projectId: string | null; projectName: string | null };

export type MessageContext = {
  now: number;
  /** リーダーの発言の名前（プロジェクト名）。agentId → プロジェクト */
  authorOf: (agentId: string | null) => AuthorInfo;
  /** このスレッドがリーダーのスレッドなら、そのプロジェクト */
  threadProjectId: string | null;
  threadKind: "coo" | "leader";
};

const LONG_PRESS_MS = 520;

function roleClass(kind: AuthorKind): string {
  return kind === "coo" ? "coo" : kind === "leader" ? "leader" : kind === "member" ? "member" : kind === "secretary" ? "secretary" : "system";
}

/** 書き手の表示（COO・リーダー · 台本・秘書から） */
export function AuthorLabel({ m, ctx }: { m: DisplayMessage; ctx: MessageContext }) {
  const info = ctx.authorOf(m.authorAgentId);
  const projectName = info.projectName ?? (ctx.threadKind === "leader" ? null : null);
  return (
    <span className={`author author--${roleClass(m.authorKind)}`}>
      <span className={`role-dot role-dot--${roleClass(m.authorKind)}`} aria-hidden="true" />
      {m.authorKind === "secretary" ? (
        <span className="author__name">{UI_TEXT_V2.conversation.fromSecretary}</span>
      ) : m.authorKind === "coo" ? (
        <span className="author__name">{UI_TEXT_V2.roles.coo}</span>
      ) : m.authorKind === "leader" ? (
        <>
          <span className="author__name">{UI_TEXT_V2.roles.leader}</span>
          {projectName && (
            <>
              <span className="author__sep" aria-hidden="true">
                ·
              </span>
              <span className="author__project">{projectName}</span>
            </>
          )}
        </>
      ) : (
        <span className="author__name">{m.authorName ?? UI_TEXT_V2.roles.member}</span>
      )}
      <span className="author__time">{messageTime(m.createdAt, ctx.now)}</span>
    </span>
  );
}

function TypingDots({ activity }: { activity: string | null }) {
  return (
    <span className="typing" data-testid={TESTIDS.messageTyping}>
      <span className="typing__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {activity && (
        <motion.span key={activity} className="typing__activity" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={spring.gentle}>
          {activity}
        </motion.span>
      )}
    </span>
  );
}

/** 指示の小さなカード（件名・状態・プロジェクト・リーダーと話す・指示を開く） */
export function InstructionMiniCard({ instructionId, fallbackTitle }: { instructionId: string; fallbackTitle?: string }) {
  const qc = useQueryClient();
  const inst: InstructionSummary | undefined = findInstruction(qc, instructionId);
  const title = inst ? cardTitle(inst) : (fallbackTitle ?? "");
  const group = inst ? displayGroup(inst) : null;
  return (
    <div className="mini-card glass glass--card" data-testid={TESTIDS.messageInstructionCard} data-id={instructionId} data-status={inst?.status ?? ""}>
      <Link to="/i/$id" params={{ id: instructionId }} className="mini-card__main" aria-label={UI_TEXT_V2.conversation.openInstruction}>
        <span className={`status-dot status-dot--${group ?? "queued"}`} aria-hidden="true" />
        <span className="mini-card__text">
          <span className="mini-card__title">{title}</span>
          <span className="mini-card__meta">
            {group && <span className={`mini-card__status mini-card__status--${group}`}>{STATUS_LABELS[group]}</span>}
            {inst?.projectName && <span className="mini-card__project">{inst.projectName}</span>}
            {inst && inst.revision > 1 && (
              <span className="rev">
                {UI_TEXT_V2.instruction.rev} {inst.revision}
              </span>
            )}
            {inst?.talkingWithCeo && (
              <span className="talking" data-testid={TESTIDS.talkingBadge}>
                {UI_TEXT_V2.sidebar.talking}
              </span>
            )}
          </span>
        </span>
        <IconChevronRight size={16} />
      </Link>
      <div className="mini-card__actions">
        {inst?.projectId && (
          <Link to="/p/$projectId/leader" params={{ projectId: inst.projectId }} className="mini-card__button" data-testid={TESTIDS.leaderLink}>
            <IconChat size={14} />
            <span>{UI_TEXT_V2.conversation.talkToLeader}</span>
          </Link>
        )}
        <Link to="/i/$id" params={{ id: instructionId }} className="mini-card__button">
          <span>{UI_TEXT_V2.conversation.openInstruction}</span>
        </Link>
      </div>
    </div>
  );
}

function LeaderReport({ m, ctx }: { m: DisplayMessage; ctx: MessageContext }) {
  const [open, setOpen] = useState(false);
  const info = ctx.authorOf(m.authorAgentId);
  return (
    <motion.button
      type="button"
      layout
      className="leader-report"
      data-open={open ? "true" : "false"}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      transition={spring.smooth}
    >
      <span className="leader-report__head">
        <span className="role-dot role-dot--leader" aria-hidden="true" />
        <span>{UI_TEXT_V2.roles.leader}</span>
        {info.projectName && <span className="leader-report__project">{info.projectName}</span>}
        <span>{UI_TEXT_V2.conversation.toCoo}</span>
        <span className="author__time">{messageTime(m.createdAt, ctx.now)}</span>
      </span>
      <span className="leader-report__body">{m.body}</span>
    </motion.button>
  );
}

function Notice({ m }: { m: DisplayMessage }) {
  const kind = typeof m.ref.notice === "string" ? m.ref.notice : null;
  const map: Record<string, string> = {
    approve: UI_TEXT_V2.notices.approve,
    send_back: UI_TEXT_V2.notices.sendBack,
    cancel: UI_TEXT_V2.notices.cancel,
    retry: UI_TEXT_V2.notices.retry,
    new_topic: UI_TEXT_V2.notices.newTopic,
  };
  const label = m.body || (kind ? map[kind] : "") || "";
  const qc = useQueryClient();
  const inst = m.instructionId ? findInstruction(qc, m.instructionId) : undefined;
  return (
    <div className={`notice notice--${kind ?? "plain"}`}>
      <span className="notice__line" aria-hidden="true" />
      <span className="notice__text">{label}</span>
      {inst && <span className="notice__title">{cardTitle(inst)}</span>}
      <span className="notice__line" aria-hidden="true" />
    </div>
  );
}

function Body({ m }: { m: DisplayMessage }) {
  const stream = useStreams((s) => s.byId[m.id]);
  if (m.status === "streaming") {
    const text = stream?.text ?? m.body;
    if (!text) return <TypingDots activity={stream?.activity ?? null} />;
    return (
      <div className="bubble__streaming">
        <Markdown text={text} />
        <span className="caret" aria-hidden="true" />
      </div>
    );
  }
  if (m.status === "failed") return <p className="bubble__failed">{UI_TEXT_V2.conversation.failedReply}</p>;
  return <Markdown text={m.body} />;
}

export const MessageItem = memo(function MessageItem({ m, ctx, grouped }: { m: DisplayMessage; ctx: MessageContext; grouped: boolean }) {
  const qc = useQueryClient();
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openMenu = (x: number, y: number) => {
    useUi.getState().setMessageMenu({ text: m.body, to: m.instructionId ? { instructionId: m.instructionId, sessionId: m.sessionId } : null, x, y });
  };
  const pressHandlers = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const { clientX, clientY } = e;
      longPress.current = setTimeout(() => openMenu(clientX, clientY), LONG_PRESS_MS);
    },
    onPointerUp: () => void (longPress.current && clearTimeout(longPress.current)),
    onPointerMove: () => void (longPress.current && clearTimeout(longPress.current)),
    onPointerCancel: () => void (longPress.current && clearTimeout(longPress.current)),
  };
  const common = {
    "data-testid": TESTIDS.message,
    "data-seq": m.seq,
    "data-author": m.authorKind,
    "data-kind": m.kind,
    "data-status": m.local ? `local-${m.local}` : m.status,
  };

  if (m.kind === "notice") {
    return (
      <div role="listitem" className="msg msg--notice" {...common}>
        <Notice m={m} />
      </div>
    );
  }
  if (m.kind === "leader_report") {
    return (
      <div role="listitem" className="msg msg--report-leader" {...common}>
        <LeaderReport m={m} ctx={ctx} />
      </div>
    );
  }
  if (m.kind === "delegation" && m.authorKind === "system") {
    return (
      <div role="listitem" className="msg msg--delegation" {...common}>
        {m.instructionId && <InstructionMiniCard instructionId={m.instructionId} fallbackTitle={m.body} />}
      </div>
    );
  }
  if (m.kind === "approval") {
    return (
      <div role="listitem" className="msg msg--approval" {...common}>
        <Link
          to="/i/$id"
          params={{ id: m.instructionId ?? "" }}
          search={m.sessionId ? { s: m.sessionId } : {}}
          className="approval-entry glass glass--card"
        >
          <IconHand size={16} />
          <span>{UI_TEXT_V2.approval.approve}</span>
          <span className="approval-entry__body">{m.body}</span>
          <IconChevronRight size={16} />
        </Link>
      </div>
    );
  }

  if (m.authorKind === "ceo") {
    return (
      <motion.div
        role="listitem"
        className="msg msg--ceo"
        {...common}
        layout="position"
        initial={m.local ? { opacity: 0, y: 10, scale: 0.98 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring.gentle}
      >
        <motion.div
          layoutId={m.local ? `msg-${m.clientId}` : undefined}
          className="bubble bubble--ceo"
          data-local={m.local ?? undefined}
          transition={spring.gentle}
          {...pressHandlers}
        >
          <Markdown text={m.body} />
        </motion.div>
        <div className="msg__foot">
          {m.local === "failed" ? (
            <button type="button" className="chip-button chip-button--danger" onClick={() => void deliver(qc, m.clientId ?? m.id)}>
              {UI_TEXT.resend}
            </button>
          ) : m.reaction === "ack" ? (
            <motion.span className="ack" data-testid={TESTIDS.messageAck} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={spring.pop}>
              {UI_TEXT_V2.conversation.read}
            </motion.span>
          ) : null}
        </div>
      </motion.div>
    );
  }

  const proposalId = m.kind === "project_proposal" && typeof m.ref.proposalId === "string" ? m.ref.proposalId : null;
  return (
    <motion.div
      role="listitem"
      className={`msg msg--agent msg--${roleClass(m.authorKind)}`}
      {...common}
      data-grouped={grouped ? "true" : undefined}
      initial={m.status === "streaming" ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.gentle}
    >
      {!grouped && <AuthorLabel m={m} ctx={ctx} />}
      {(m.body || m.status === "streaming" || m.status === "failed") && (
        <div className={`bubble bubble--agent bubble--${roleClass(m.authorKind)}`} data-status={m.status} {...pressHandlers}>
          <Body m={m} />
          {m.status === "canceled" && <span className="bubble__canceled">{UI_TEXT_V2.composer.interrupt}</span>}
        </div>
      )}
      {proposalId && <ProposalCard proposalId={proposalId} now={ctx.now} />}
      {(m.kind === "report" || m.kind === "delegation") && m.instructionId && <InstructionMiniCard instructionId={m.instructionId} />}
    </motion.div>
  );
});

/** リーダーのスレッドの見出しの下に出す、チームの頭文字の列（13.4） */
export function TeamStrip({ members }: { members: { id: string; name: string; state: string; to: { instructionId: string; sessionId: string } | null }[] }) {
  return (
    <div className="team-strip">
      {members.map((m) =>
        m.to ? (
          <Link key={m.id} to="/i/$id" params={{ id: m.to.instructionId }} search={{ s: m.to.sessionId }} className="team-strip__item" data-state={m.state} aria-label={m.name}>
            <span className="team-strip__initial">{m.name.charAt(0)}</span>
            <span className={`state-dot state-dot--${m.state}`} aria-hidden="true" />
          </Link>
        ) : (
          <span key={m.id} className="team-strip__item" data-state={m.state} aria-label={m.name}>
            <span className="team-strip__initial">{m.name.charAt(0)}</span>
            <span className={`state-dot state-dot--${m.state}`} aria-hidden="true" />
          </span>
        ),
      )}
    </div>
  );
}

export { IconBranch };
