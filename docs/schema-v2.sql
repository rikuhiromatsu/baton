-- Baton D1 スキーマ v2 の差分（DESIGN-v2.md 8 章の付録）
-- このファイルの内容を app/migrations/0002_v2.sql にそのまま置く（正本はマイグレーション側）。
-- ただし bot_rate_slots は後から足したもので、0003_bot_rate_slots.sql にある（D-119）。
-- 前提: 0001_init.sql（docs/schema.sql）が適用済み。
-- 表を作る順番: runner_repos → workspaces → threads（instructions の ALTER が参照するので先）→ … の順に並べ替えてある。
-- 規則は v1 と同じ: 時刻は UNIX ミリ秒の INTEGER、ID は TEXT、真偽値は 0/1、JSON は TEXT（json_valid で検査）。
-- SQLite の ALTER TABLE ADD COLUMN の制約（UNIQUE 不可、NOT NULL は既定値が要る、REFERENCES は既定値 NULL のときだけ）に合わせてある。

-- ───────────── プロジェクトと作業場所 ─────────────

-- プロジェクトの作業場所の種類。baton = ~/baton-data/projects/<slug>（Baton が git init して持つ）、repo = 既存リポジトリ（~/projects 配下）
ALTER TABLE projects ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'baton' CHECK (workspace_kind IN ('baton','repo'));
-- 既存リポジトリの絶対パス。runner_repos にあるものだけ設定できる（Worker が検査）
ALTER TABLE projects ADD COLUMN repo_path TEXT;
-- worktree の元にするブランチ（NULL ならリポジトリの既定ブランチ）
ALTER TABLE projects ADD COLUMN base_branch TEXT;
CREATE UNIQUE INDEX uq_projects_repo ON projects(repo_path) WHERE repo_path IS NOT NULL;
-- プロジェクトの目的（COO との会話で固めたもの。summary は COO が振り分けに使う短い説明のまま）
ALTER TABLE projects ADD COLUMN goal TEXT NOT NULL DEFAULT '';

-- エージェントの職種プロファイル（runner/profiles/profiles.json のキー。DESIGN-v2 6 章）。NULL なら役割の既定（coo / leader / generalist）
ALTER TABLE agents ADD COLUMN profile TEXT;

-- メンバーのタスクが触ってよい範囲（リーダーの plan の paths。DESIGN-v2 4.6・7.3。D-96）
ALTER TABLE tasks ADD COLUMN paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(paths));

-- ランナーが ~/projects を走査して見つけた git リポジトリの候補（画面の「リポジトリを紐づける」の選択肢）
CREATE TABLE runner_repos (
  path           TEXT PRIMARY KEY,             -- 絶対パス（realpath 済み、~/projects 配下）
  runner_id      TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,                -- 表示名（例: rikuhiromatsu/my-project）
  default_branch TEXT,                         -- 例: main
  head_sha       TEXT,
  last_commit_at INTEGER,
  dirty          INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0,1)),  -- 本体の作業ツリーに未コミットの変更があるか（表示用。Baton は本体に触らない）
  seen_at        INTEGER NOT NULL              -- 最後に走査で見えた時刻。24 時間見えなければ候補から消す
);
CREATE INDEX idx_runner_repos_runner ON runner_repos(runner_id, name);

-- git worktree とブランチ（DESIGN-v2 7.3）。指示×プロジェクトに「統合用」が 1 つ、メンバーの work タスクごとに「タスク用」が 1 つ
CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('integration','task')),
  task_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,          -- purpose = task のとき
  parent_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,     -- タスク用の元になった統合用
  kind           TEXT NOT NULL CHECK (kind IN ('baton','repo')),
  repo_path      TEXT NOT NULL,                -- git の本体（baton なら ~/baton-data/projects/<slug>）
  worktree_path  TEXT NOT NULL,                -- 統合用: ~/baton-data/worktrees/<id8>/<slug>/main、タスク用: …/<slug>/<タスクキー>-r<ラウンド>
  branch         TEXT NOT NULL,                -- 統合用: baton/<id8>/main、タスク用: baton/<id8>/<タスクキー>-r<ラウンド>
  base_ref       TEXT NOT NULL,                -- 統合用: 例 main / タスク用: 統合用のブランチ
  base_sha       TEXT NOT NULL,
  head_sha       TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','merged','conflict','kept','removed','failed')),
                 -- タスク用 merged: 統合用へ取り込み済み / conflict: 取り込みで衝突
                 -- 統合用 merged: baton の main へ取り込み済み / kept: repo のブランチを残して worktree を消した / removed: 変更なしで消した
  diff_stat      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diff_stat)),  -- [{ path, added, removed, change: "A"|"M"|"D"|"R" }]
  diff_patch     TEXT,                         -- git diff base...HEAD の先頭 200,000 文字
  diff_truncated INTEGER NOT NULL DEFAULT 0 CHECK (diff_truncated IN (0,1)),
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finalized_at   INTEGER,
  CHECK ((purpose = 'integration' AND task_id IS NULL) OR (purpose = 'task' AND task_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_workspaces_integration ON workspaces(instruction_id, project_id) WHERE purpose = 'integration';
CREATE UNIQUE INDEX uq_workspaces_task ON workspaces(task_id) WHERE purpose = 'task';
CREATE UNIQUE INDEX uq_workspaces_path ON workspaces(worktree_path) WHERE status IN ('active','conflict');
CREATE INDEX idx_workspaces_status ON workspaces(status, updated_at);

-- ───────────── 会話（スレッド） ─────────────

-- CEO と話す相手ごとのスレッド。COO は全体で 1 本、リーダーはプロジェクトに 1 本（DESIGN-v2 3・4 章）
CREATE TABLE threads (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('coo','leader')),
  project_id         TEXT REFERENCES projects(id) ON DELETE CASCADE,
  agent_id           TEXT REFERENCES agents(id) ON DELETE SET NULL,
  current_session_id TEXT,                     -- いま続けている Claude のセッション（agent_sessions.id）。NULL なら次のターンで新しく作る
  status             TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','queued','running')),
                     -- idle: 受け取るものが無い / queued: 受信箱に未処理がある / running: ランナーがターンを回している
  lease_runner_id    TEXT REFERENCES runners(id),
  lease_expires_at   INTEGER,
  not_before         INTEGER,                  -- 枠切れなどでこの時刻まで取り出さない
  last_seq           INTEGER NOT NULL DEFAULT 0,  -- thread_messages の最後の seq
  last_message_at    INTEGER,
  awaiting_reply     INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_reply IN (0,1)),  -- 相手が CEO に質問して返事を待っている
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((kind = 'coo' AND project_id IS NULL) OR (kind = 'leader' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_threads_coo ON threads(kind) WHERE kind = 'coo';
CREATE UNIQUE INDEX uq_threads_project ON threads(project_id) WHERE kind = 'leader';
CREATE INDEX idx_threads_claim ON threads(status, not_before, updated_at);

-- スレッドの発言（チャットの吹き出しと、委任・報告・共有などの小さなカード）
CREATE TABLE thread_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,            -- スレッドごとの通し番号（Worker が採番）
  client_id       TEXT UNIQUE,                 -- CEO の発言だけ。端末が採番する冪等キー
  author_kind     TEXT NOT NULL CHECK (author_kind IN ('ceo','coo','leader','member','system','secretary')),
                  -- secretary: 秘書 bot が CEO の代理で送った発言（DESIGN-v2 11 章）
  author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'chat'
                  CHECK (kind IN ('chat','delegation','report','leader_report','notice','approval','project_proposal')),
                  -- project_proposal: COO のプロジェクト案（project_proposals を指す。CEO が「立てる」を押す）
                  -- chat: 普通の発言 / delegation: 指示が生まれた・振られた / report: 指示の成果（COO → CEO）
                  -- leader_report: リーダーが CEO と直接話した内容を COO へ報告したもの（COO スレッドに残る）
                  -- notice: 状態の知らせ（リーダーと話し中、取消など） / approval: 承認の依頼への入口
  body            TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 32000),  -- Markdown
  instruction_id  TEXT REFERENCES instructions(id) ON DELETE SET NULL,
  session_id      TEXT,                        -- この発言を書いたターンのセッション（「作業を見る」の行き先）
  ref             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ref)),  -- { fromSeq, toSeq, decisionId, threadId, contextProjectId, ... }
  status          TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','failed','canceled')),
  reaction        TEXT CHECK (reaction IS NULL OR reaction IN ('ack')),  -- 相手が言葉を返さずに受け取った印（CEO の発言に付く）
  notify          INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0,1)),     -- 未読に数え、通知するか（DESIGN-v2 4.8・10 章）
  bot_token_id    TEXT,                        -- author_kind = secretary のとき、どの bot トークンか
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_thread_messages_seq ON thread_messages(thread_id, seq);
CREATE INDEX idx_thread_messages_instruction ON thread_messages(instruction_id, created_at) WHERE instruction_id IS NOT NULL;

-- 既読（利用者ごと・スレッドごとに、最後に読んだ seq）
CREATE TABLE thread_reads (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  last_read_seq  INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);

-- スレッドの受信箱。次のターンでセッションに渡すもの（CEO の発言、下からの報告、共有など）。ランナーが消化したら consumed
CREATE TABLE thread_inbox (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'ceo_message',      -- CEO の発言（message_id）
                   'delegation',       -- COO からリーダーへの依頼・連絡
                   'member_results',   -- そのラウンドのメンバーの結果がそろった
                   'member_question',  -- メンバーからリーダーへの質問
                   'work_report',      -- リーダーから COO への指示の成果の報告
                   'leader_report',    -- リーダーが CEO と直接話した内容の報告（方針の変更があればターンを起こす）
                   'merge_conflict',   -- メンバーのブランチを統合用へ取り込むときに衝突した
                   'project_created',  -- CEO がプロジェクト案を「立てる」で受け入れた
                   'secretary_message',-- 秘書 bot からの発言（CEO の指示ではなくデータとして渡す）
                   'review_findings',  -- 統合後の Codex レビューの指摘（DESIGN-v2 6.4）
                   'instruction_event' -- 承認・差し戻し・取消・失敗などの知らせ
                 )),
  wakes          INTEGER NOT NULL DEFAULT 1 CHECK (wakes IN (0,1)),  -- 0 ならこれだけではターンを起こさない（次のターンの頭に入る）
  message_id     TEXT REFERENCES thread_messages(id) ON DELETE SET NULL,
  instruction_id TEXT REFERENCES instructions(id) ON DELETE CASCADE,
  payload        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','canceled')),
  created_at     INTEGER NOT NULL,
  consumed_at    INTEGER
);
CREATE INDEX idx_thread_inbox_pending ON thread_inbox(thread_id, created_at) WHERE status = 'pending';

-- ───────────── 指示 ─────────────

-- 指示は会話から生まれる（DESIGN-v2 3・4 章）。どのスレッドのどの発言から生まれたか
ALTER TABLE instructions ADD COLUMN origin_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
ALTER TABLE instructions ADD COLUMN origin_message_id TEXT;
-- running の中の段階: leader = リーダーのターン待ち・実行中 / members = メンバーのセッション / coo = COO のターン待ち・実行中
-- 方針の版。CEO がリーダーと直接話して方針・範囲が変わるたびに +1。COO の古い前提の行動を弾くのに使う（DESIGN-v2 4.6）
ALTER TABLE instructions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE instructions ADD COLUMN phase TEXT CHECK (phase IS NULL OR phase IN ('leader','members','coo'));
-- 承認（done）後の確定処理（マージ・worktree の片付け）を済ませた時刻
ALTER TABLE instructions ADD COLUMN finalized_at INTEGER;
-- Claude Code が result に出す推定額（USD）の合計。サブスクでは請求額ではない（D-56）
ALTER TABLE instructions ADD COLUMN cost_usd_est REAL NOT NULL DEFAULT 0;
CREATE INDEX idx_instructions_finalize ON instructions(status, finalized_at) WHERE status = 'done' AND finalized_at IS NULL;

-- ───────────── ランナー ─────────────

-- 直近のサブスク枠の様子（QuotaStatus の JSON。DESIGN-v2 9 章）
ALTER TABLE runners ADD COLUMN quota TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(quota));
ALTER TABLE runners ADD COLUMN claude_version TEXT;
-- claude auth status の要約: ok / not_logged_in / not_subscription / unknown
ALTER TABLE runners ADD COLUMN claude_auth TEXT NOT NULL DEFAULT 'unknown'
  CHECK (claude_auth IN ('ok','not_logged_in','not_subscription','unknown'));

-- ───────────── Claude のセッション ─────────────

-- 1 行 = Claude Code の 1 セッション。id は Claude の session_id（ランナーが --session-id で採番して渡す）
-- COO・リーダーはスレッドのセッション（thread_id、指示をまたいで続く）。メンバーは指示のタスクごとのセッション（instruction_id）
CREATE TABLE agent_sessions (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT REFERENCES threads(id) ON DELETE CASCADE,
  instruction_id TEXT REFERENCES instructions(id) ON DELETE CASCADE,
  agent_id       TEXT REFERENCES agents(id) ON DELETE SET NULL,
  role           TEXT NOT NULL CHECK (role IN ('coo','leader','member','legacy')),
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,   -- member の work タスク
  workspace_id   TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  title          TEXT NOT NULL DEFAULT '',     -- タブに出す名前（例: リーダー、リサーチ）。エージェント名の写し
  cwd            TEXT NOT NULL DEFAULT '',
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','awaiting_approval','idle','paused','quota_wait','done','failed','canceled')),
                 -- pending: まだ起動していない / running: プロセスがターンを回している / awaiting_approval: プロセス内で承認待ち
                 -- idle: ターンを終え次の入力待ち（プロセスは終了済み、--resume で再開できる）
                 -- paused: CEO の回答待ちで止めた（pause_reason） / quota_wait: 枠切れで止めた
  pause_reason   TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('question','approval','interrupted')),
  activity       TEXT,                         -- いまの動き（ランナーが日本語の 1 行に要約。例: 編集 src/a.ts）
  activity_at    INTEGER,
  turns          INTEGER NOT NULL DEFAULT 0,   -- result の num_turns の合計
  cost_usd_est   REAL NOT NULL DEFAULT 0,
  tokens_in      INTEGER NOT NULL DEFAULT 0,   -- input + cache_creation（cache_read は含めない）
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  last_seq       INTEGER NOT NULL DEFAULT 0,   -- transcript_items の最後の seq
  claude_version TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  ended_at       INTEGER,
  updated_at     INTEGER NOT NULL,
  CHECK (thread_id IS NOT NULL OR instruction_id IS NOT NULL)
);
CREATE INDEX idx_agent_sessions_thread ON agent_sessions(thread_id, created_at);
CREATE INDEX idx_agent_sessions_instruction ON agent_sessions(instruction_id, created_at);
CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id, updated_at DESC);
CREATE INDEX idx_agent_sessions_live ON agent_sessions(status, updated_at DESC)
  WHERE status IN ('running','awaiting_approval','paused','quota_wait');

-- トランスクリプト（stream-json を正規化した項目）。生の jsonl は Mac mini に全部残す
CREATE TABLE transcript_items (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  thread_id          TEXT REFERENCES threads(id) ON DELETE CASCADE,
  instruction_id     TEXT REFERENCES instructions(id) ON DELETE CASCADE,  -- そのターンが扱っていた指示（スレッドのターンで指示と無関係なら NULL）
  seq                INTEGER NOT NULL,         -- セッションごとの通し番号（ランナーが採番）
  kind               TEXT NOT NULL CHECK (kind IN (
                       'user',         -- セッションへの入力（CEO のフォローアップ、上司からの依頼、ランナーの連絡）
                       'text',         -- Claude の文章
                       'thinking',     -- 考え（中身が空なら作らない）
                       'tool_use',     -- 道具の呼び出し
                       'tool_result',  -- 道具の結果（Edit/Write は差分を含む）
                       'approval',     -- 承認の依頼と結論（decisions を指す）
                       'question',     -- CEO への質問（ask_ceo）
                       'denied',       -- 権限で拒否された操作
                       'output',       -- 構造化出力（route / plan / done など）
                       'system',       -- 開始・再試行・枠・中断などの知らせ
                       'result',       -- 1 ターンの終わり
                       'error',
                       'legacy'        -- v1 の agent_events から移したもの
                     )),
  author             TEXT NOT NULL CHECK (author IN ('ceo','runner','claude','system')),
  tool_name          TEXT,
  tool_use_id        TEXT,
  parent_tool_use_id TEXT,
  summary            TEXT NOT NULL DEFAULT '', -- 1 行（200 文字まで）。折りたたみ表示と組織図の「いまの動き」に使う
  body               TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body)),  -- 種類ごとの中身（DESIGN-v2 8.3）。上限で切る
  truncated          INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  is_error           INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0,1)),
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_transcript_items_seq ON transcript_items(session_id, seq);
CREATE INDEX idx_transcript_items_instruction ON transcript_items(instruction_id, created_at) WHERE instruction_id IS NOT NULL;
CREATE INDEX idx_transcript_items_tool ON transcript_items(session_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

-- CEO がセッションに送ったフォローアップ。ランナーが届けたら delivered
CREATE TABLE session_inputs (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL UNIQUE,         -- 端末が採番する冪等キー
  session_id     TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  body           TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','canceled')),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  delivered_at   INTEGER
);
CREATE INDEX idx_session_inputs_pending ON session_inputs(session_id, created_at) WHERE status = 'pending';
CREATE INDEX idx_session_inputs_instruction ON session_inputs(instruction_id, created_at);

-- ───────────── 判断待ちの拡張（質問・承認・中断） ─────────────

ALTER TABLE decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'question' CHECK (kind IN ('question','approval','interrupted'));
ALTER TABLE decisions ADD COLUMN session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
-- 承認（kind = approval）のときだけ: 何をしようとしたか
ALTER TABLE decisions ADD COLUMN tool_name TEXT;
ALTER TABLE decisions ADD COLUMN tool_input TEXT CHECK (tool_input IS NULL OR json_valid(tool_input));
ALTER TABLE decisions ADD COLUMN tool_use_id TEXT;
-- 承認の結論（answer にはコメントが入る）
ALTER TABLE decisions ADD COLUMN verdict TEXT CHECK (verdict IS NULL OR verdict IN ('allow','deny'));
-- 秘書 bot の回答案（最終決定は CEO）
ALTER TABLE decisions ADD COLUMN suggestion TEXT;
ALTER TABLE decisions ADD COLUMN suggestion_verdict TEXT CHECK (suggestion_verdict IS NULL OR suggestion_verdict IN ('allow','deny'));
ALTER TABLE decisions ADD COLUMN suggestion_at INTEGER;
CREATE INDEX idx_decisions_session ON decisions(session_id, status);

-- ───────────── v1 データの移し替え ─────────────

-- v1 の実行ログ（agent_events）は、指示ごとに 1 つの legacy セッションへ移す。agent_events は 0003 で消す（D-63）
INSERT INTO agent_sessions (id, instruction_id, agent_id, role, project_id, title, status, last_seq, created_at, started_at, ended_at, updated_at)
SELECT 'legacy-' || i.id, i.id, 'agent-coo', 'legacy', i.project_id, 'v1', 'done',
       (SELECT MAX(e.seq) FROM agent_events e WHERE e.instruction_id = i.id),
       i.created_at, i.created_at, i.updated_at, i.updated_at
FROM instructions i
WHERE EXISTS (SELECT 1 FROM agent_events e WHERE e.instruction_id = i.id);

INSERT INTO transcript_items (id, session_id, instruction_id, seq, kind, author, summary, body, created_at)
SELECT e.id, 'legacy-' || e.instruction_id, e.instruction_id, e.seq, 'legacy', 'system', e.kind,
       json_object('kind', e.kind, 'content', json(e.content), 'agentId', e.agent_id, 'taskId', e.task_id, 'model', e.model),
       e.created_at
FROM agent_events e;

-- ───────────── プロジェクト案 ─────────────

-- COO が会話の中で出すプロジェクト案。CEO が「立てる」を押すと projects ができる（DESIGN-v2 3 章）
CREATE TABLE project_proposals (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id     TEXT REFERENCES thread_messages(id) ON DELETE SET NULL,
  payload        TEXT NOT NULL CHECK (json_valid(payload)),  -- { name, slug, goal, summary, workspace: { kind, repoPath? }, leader, members[] }
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','superseded')),
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER
);
CREATE INDEX idx_project_proposals_pending ON project_proposals(status, created_at) WHERE status = 'pending';

-- ───────────── 通知（Web Push） ─────────────

CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,        -- プッシュサービスの URL（許可したホストだけ受け付ける）
  p256dh          TEXT NOT NULL,               -- 端末の公開鍵（base64url）
  auth            TEXT NOT NULL,               -- 認証用の秘密（base64url）
  device_label    TEXT NOT NULL DEFAULT '',    -- 例: iPhone（PWA）
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  failures        INTEGER NOT NULL DEFAULT 0,  -- 連続の送信失敗。5 回で enabled = 0
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, enabled);

-- ───────────── 秘書 bot ─────────────

-- bot 用のトークン。本体は発行時に 1 回だけ見せ、D1 には SHA-256 だけ
CREATE TABLE bot_tokens (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                 -- 例: Grok 秘書
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL CHECK (json_valid(scopes)),  -- ["read","message","propose"] の部分集合
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

-- bot がしたことの記録（読み取りも含む。90 日で消す）
CREATE TABLE bot_audit_log (
  id            TEXT PRIMARY KEY,
  token_id      TEXT NOT NULL REFERENCES bot_tokens(id) ON DELETE CASCADE,
  via           TEXT NOT NULL CHECK (via IN ('mcp','http')),
  action        TEXT NOT NULL,                 -- 道具の名前（例: baton_send_to_coo）
  target        TEXT,                          -- 対象の ID
  summary       TEXT NOT NULL DEFAULT '',      -- 引数の要約（本文は先頭 200 文字）
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok','denied','invalid','rate_limited','error')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_bot_audit_token ON bot_audit_log(token_id, created_at DESC);

-- 秘書 bot の送信枠（0003。D-119）。判定と予約を 1 文の条件付き INSERT で行う（並行した呼び出しでも上限を超えない）
CREATE TABLE bot_rate_slots (
  token_id      TEXT NOT NULL REFERENCES bot_tokens(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,                 -- 道具の名前（baton_send_to_coo・baton_propose_answer）
  request_id    TEXT NOT NULL,                 -- 送信は bot の requestId、回答案は呼び出しごとの ID
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (token_id, action, request_id)
);
CREATE INDEX idx_bot_rate_slots_time ON bot_rate_slots(token_id, action, created_at DESC);

-- ───────────── スレッドの初期データ ─────────────

INSERT INTO threads (id, kind, project_id, agent_id, status, created_at, updated_at)
VALUES ('thread-coo', 'coo', NULL, 'agent-coo', 'idle', 0, 0);

INSERT INTO threads (id, kind, project_id, agent_id, status, created_at, updated_at)
SELECT 'thread-' || p.id, 'leader', p.id,
       (SELECT a.id FROM agents a WHERE a.project_id = p.id AND a.role = 'leader' AND a.active = 1),
       'idle', p.created_at, p.updated_at
FROM projects p;

-- v1 の指示は、COO スレッドの過去のやりとり（CEO の依頼と COO の報告）として残す
INSERT INTO thread_messages (id, thread_id, seq, client_id, author_kind, author_agent_id, kind, body, instruction_id, status, created_at, updated_at)
SELECT 'v1-ceo-' || i.id, 'thread-coo', 2 * ROW_NUMBER() OVER (ORDER BY i.created_at, i.id) - 1, i.client_id, 'ceo', NULL, 'chat',
       i.body, i.id, 'complete', i.created_at, i.created_at
FROM instructions i;
INSERT INTO thread_messages (id, thread_id, seq, author_kind, author_agent_id, kind, body, instruction_id, status, created_at, updated_at)
SELECT 'v1-coo-' || i.id, 'thread-coo', 2 * i.n, 'coo', 'agent-coo', 'report',
       i.result_summary, i.id, 'complete', COALESCE(i.completed_at, i.updated_at), COALESCE(i.completed_at, i.updated_at)
FROM (SELECT x.*, ROW_NUMBER() OVER (ORDER BY x.created_at, x.id) AS n FROM instructions x) i  -- 番号は全指示で振ってから絞る（CEO の発言と同じ番号）
WHERE i.result_summary IS NOT NULL;
UPDATE threads SET last_seq = (SELECT COALESCE(MAX(seq), 0) FROM thread_messages m WHERE m.thread_id = 'thread-coo'),
                   last_message_at = (SELECT MAX(created_at) FROM thread_messages m WHERE m.thread_id = 'thread-coo')
WHERE id = 'thread-coo';
UPDATE instructions SET origin_thread_id = 'thread-coo', origin_message_id = 'v1-ceo-' || id;
-- 既存の利用者は v1 の分を既読にしておく
INSERT INTO thread_reads (user_id, thread_id, last_read_seq, updated_at)
SELECT u.id, 'thread-coo', (SELECT last_seq FROM threads WHERE id = 'thread-coo'), 0 FROM users u;

-- Workers AI の使用量は v2 では使わない（サブスク枠は runners.quota）
DROP TABLE ai_usage;
