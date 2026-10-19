-- Baton D1 スキーマ（初版）
-- このファイルの内容を app/migrations/0001_init.sql にそのまま置く（正本はマイグレーション側。ここは設計書の付録）。
-- 時刻はすべて UNIX ミリ秒の INTEGER。ID は crypto.randomUUID() の TEXT。
-- 真偽値は INTEGER 0/1。JSON は TEXT（json_valid で検査）。

-- D1 は外部キー制約を既定で強制する（PRAGMA は書かない）

-- ───────────── 利用者・認証 ─────────────

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- 小文字に正規化して保存
  name          TEXT NOT NULL DEFAULT '',
  picture_url   TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- セッション。Cookie にはランダムなトークン本体、DB にはその SHA-256（hex）だけを置く
CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,                 -- X-Baton-CSRF ヘッダと照合
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- OAuth の一時状態（state と PKCE の code_verifier）。10 分で失効、使ったら即削除
CREATE TABLE oauth_flows (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_to   TEXT NOT NULL DEFAULT '/',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_oauth_flows_expires ON oauth_flows(expires_at);

-- ───────────── 組織（プロジェクト・エージェント） ─────────────

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,          -- ^[a-z0-9][a-z0-9-]{1,39}$ 。Mac mini の作業フォルダ名にも使う
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',      -- COO がプロジェクト選択に使う説明
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_projects_status ON projects(status, updated_at DESC);

-- エージェント定義。COO は project_id が NULL の 1 体だけ（初期データで投入）
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('coo','leader','member')),
  name          TEXT NOT NULL,                 -- 表示名（例: 調査担当）
  specialty     TEXT NOT NULL DEFAULT '',      -- 得意分野。リーダーの割り振りとプロンプトに使う
  model         TEXT,                          -- NULL なら役割の既定モデル
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    INTEGER NOT NULL,
  CHECK ((role = 'coo' AND project_id IS NULL) OR (role <> 'coo' AND project_id IS NOT NULL))
);
CREATE INDEX idx_agents_project ON agents(project_id, role);
CREATE UNIQUE INDEX uq_agents_single_coo ON agents(role) WHERE role = 'coo';
CREATE UNIQUE INDEX uq_agents_one_leader ON agents(project_id) WHERE role = 'leader' AND active = 1;

-- ───────────── ランナー（Mac mini） ─────────────

CREATE TABLE runners (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,             -- 例: rikumac-mini
  token_hash        TEXT NOT NULL UNIQUE,      -- ランナートークンの SHA-256（hex）
  version           TEXT,
  tailnet_url       TEXT,                      -- 例: https://rikumac-mini.tail6eb659.ts.net
  last_heartbeat_at INTEGER,
  status            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(status)),  -- 実行中の指示 ID、同時実行数など
  revoked           INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at        INTEGER NOT NULL
);

-- ───────────── 指示とタスク ─────────────

-- 指示（CEO → COO）。フリックで動かすステータスはここ
CREATE TABLE instructions (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL UNIQUE,       -- 端末側で採番。二重送信の防止（冪等キー）
  created_by       TEXT NOT NULL REFERENCES users(id),
  body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  title            TEXT,                       -- COO が付ける短い件名。NULL の間は本文先頭を表示
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','needs_decision','review','done','failed','canceled','archived')),
  status_changed_at INTEGER NOT NULL,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  result_summary   TEXT,                       -- COO から CEO への最終報告
  feedback         TEXT,                       -- 差し戻し時の CEO のコメント（次の実行で COO に渡す）
  error            TEXT,                       -- failed のときの理由
  attempt          INTEGER NOT NULL DEFAULT 0, -- 実行を始めた回数
  lease_runner_id  TEXT REFERENCES runners(id),
  lease_expires_at INTEGER,                    -- ランナーの占有期限。切れたら他が取り直せる
  not_before       INTEGER,                    -- AI 枠切れ等で、この時刻まで取り出さない
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_instructions_status ON instructions(status, updated_at DESC);
CREATE INDEX idx_instructions_claim ON instructions(status, not_before, created_at);
CREATE INDEX idx_instructions_lease ON instructions(lease_expires_at) WHERE status = 'running';
CREATE INDEX idx_instructions_project ON instructions(project_id, created_at DESC);

-- ステータス遷移の記録。取り消し（undo）と監査に使う
CREATE TABLE status_transitions (
  id             TEXT PRIMARY KEY,
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  from_status    TEXT NOT NULL,
  to_status      TEXT NOT NULL,
  action         TEXT NOT NULL,                -- approve / cancel / send_back / archive / retry / restore / undo / system
  actor          TEXT NOT NULL CHECK (actor IN ('ceo','runner','system')),
  undone         INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0,1)),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_transitions_instruction ON status_transitions(instruction_id, created_at DESC);

-- タスク。リーダーの計画（plan）、メンバーの作業（work）、リーダーのまとめ（review）
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  instruction_id   TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  parent_task_id   TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('plan','work','review')),
  plan_key         TEXT,                       -- リーダーの計画内のキー（t1, t2 …）。依存関係の参照に使う
  depends_on       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),  -- plan_key の配列
  title            TEXT NOT NULL,
  spec             TEXT NOT NULL DEFAULT '',   -- 何をどこまでやるか
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','failed','canceled')),
  result_summary   TEXT,
  round            INTEGER NOT NULL DEFAULT 1, -- リーダーのやり直し回数（最大 2）
  seq              INTEGER NOT NULL,           -- 同じ親の中の表示順
  attempt          INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_tasks_instruction ON tasks(instruction_id, parent_task_id, seq);
CREATE INDEX idx_tasks_status ON tasks(instruction_id, status);
CREATE UNIQUE INDEX uq_tasks_plan_key ON tasks(instruction_id, round, plan_key) WHERE plan_key IS NOT NULL;

-- CEO への確認事項
CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,
  instruction_id    TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  asked_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  question          TEXT NOT NULL,
  options           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options)),   -- 文字列の配列（0〜4 個）
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','canceled')),
  answer            TEXT,
  answered_at       INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_decisions_instruction ON decisions(instruction_id, created_at);
CREATE INDEX idx_decisions_open ON decisions(status) WHERE status = 'open';

-- ───────────── 実行ログ・成果物 ─────────────

-- エージェントの実行ログ（LLM 呼び出し・道具の使用・要約など）。content は 16KB で切る
CREATE TABLE agent_events (
  id             TEXT PRIMARY KEY,
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id       TEXT REFERENCES agents(id) ON DELETE SET NULL,
  seq            INTEGER NOT NULL,             -- 指示ごとの通し番号（ランナーが採番。再開時は続きから）
  kind           TEXT NOT NULL CHECK (kind IN ('llm_call','action','tool_call','tool_result','summary','decision','note','error')),
  content        TEXT NOT NULL CHECK (json_valid(content)),
  model          TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  duration_ms    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_agent_events_seq ON agent_events(instruction_id, seq);

-- 成果物。本体は Mac mini の作業フォルダ。D1 には目録と先頭 64KB のテキスト（あれば）
CREATE TABLE artifacts (
  id             TEXT PRIMARY KEY,
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  rel_path       TEXT NOT NULL,                -- プロジェクト作業フォルダからの相対パス
  title          TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  preview_text   TEXT,                         -- テキスト系だけ。65,536 文字まで
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_instruction ON artifacts(instruction_id, created_at);
CREATE UNIQUE INDEX uq_artifacts_path_hash ON artifacts(instruction_id, rel_path, sha256);

-- ───────────── AI 使用量 ─────────────

CREATE TABLE ai_usage (
  id             TEXT PRIMARY KEY,
  day            TEXT NOT NULL,                -- UTC の YYYY-MM-DD（Workers AI の無料枠が UTC 00:00 で戻るため）
  model          TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('coo','leader','member','util')),
  instruction_id TEXT REFERENCES instructions(id) ON DELETE SET NULL,
  tokens_in      INTEGER NOT NULL,
  tokens_out     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_ai_usage_day ON ai_usage(day, model);
CREATE INDEX idx_ai_usage_instruction ON ai_usage(instruction_id);

-- ───────────── 初期データ ─────────────

INSERT INTO agents (id, project_id, role, name, specialty, model, active, created_at)
VALUES ('agent-coo', NULL, 'coo', 'COO', '指示の解釈、プロジェクトとチームの割り当て、最終報告', NULL, 1, 0);
