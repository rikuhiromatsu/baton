// 確定（DESIGN-v2 7.5、D-50・D-66）。承認から 20 秒後に claim で来る。
import { COO_THREAD_ID, type ClaimOutput } from "@baton/shared";
import { randomUUID } from "node:crypto";
import type { RunnerContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { finalizeWorkspaces } from "../git/workspaces.ts";
import { clip } from "./common.ts";

export type FinalizeClaim = Extract<ClaimOutput, { kind: "finalize" }>;

export async function runFinalize(ctx: RunnerContext, claim: FinalizeClaim): Promise<string> {
  const { instruction, project, workspaces } = claim;
  try {
    const r = await finalizeWorkspaces(ctx, { instructionId: instruction.id, project, workspaces });
    await ctx.api.finalized(instruction.id, { outcome: r.outcome, branch: r.branch, error: r.error ?? null });
    if (r.outcome === "kept" && project.workspaceKind === "baton") {
      await ctx.api
        .postMessage(COO_THREAD_ID, {
          id: randomUUID(),
          authorKind: "system",
          authorAgentId: null,
          kind: "notice",
          body: clip(`「${instruction.title ?? instruction.id.slice(0, 8)}」を main に取り込めませんでした。${r.branch ?? ""} に残しています`, 1000),
          instructionId: instruction.id,
          sessionId: null,
          ref: { notice: "finalize_kept" },
          status: "complete",
          notify: false,
        })
        .catch(() => undefined);
    }
    return r.outcome;
  } catch (err) {
    ctx.log.error("確定に失敗", { instructionId: instruction.id, error: errorMessage(err) });
    await ctx.api.finalized(instruction.id, { outcome: "failed", branch: null, error: clip(errorMessage(err), 4000) }).catch(() => undefined);
    return "failed";
  }
}
