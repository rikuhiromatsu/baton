// Hono のコンテキスト型
import type { Env } from "./env.ts";
import type { BotTokenRow, RunnerRow, SessionRow, UserRow } from "./db/rows.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    session: SessionRow;
    runner: RunnerRow;
    botToken: BotTokenRow;
  };
};
