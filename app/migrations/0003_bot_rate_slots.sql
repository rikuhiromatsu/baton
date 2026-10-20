-- 秘書 bot の送信枠（DESIGN-v2 11.6・D-119）。
-- 判定（間隔・日次件数）と予約を 1 文の条件付き INSERT … SELECT … WHERE で行い、並行した呼び出しでも上限を超えない。
-- 同じ (token_id, action, request_id) は 1 行だけ（送り直しは枠を再消費しない）。予約後に送信が失敗しても行は残す（件数に数える）。
CREATE TABLE bot_rate_slots (
  token_id      TEXT NOT NULL REFERENCES bot_tokens(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,                 -- 道具の名前（baton_send_to_coo・baton_propose_answer）
  request_id    TEXT NOT NULL,                 -- 送信は bot の requestId、回答案は呼び出しごとの ID
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (token_id, action, request_id)
);
CREATE INDEX idx_bot_rate_slots_time ON bot_rate_slots(token_id, action, created_at DESC);
