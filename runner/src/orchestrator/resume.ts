// 再開の位置を決める（設計書 5.9）。claim したら毎回 GET …/state を取り、ここで続きを決める。
//   - title が無い・COO の振り分けイベントが無い → 段階 1
//   - plan タスクが done でない → 段階 2（pending の work タスクがあれば作り直さず使う）
//   - done でない work タスクがある → それらだけ実行（running のまま残っていたものも再実行）
//   - 全 work が終わっていて review タスクが done でない → 段階 4
//   - それ以外 → 段階 5
// 補足（設計に無い分の決め）:
//   - 振り分け済みでもプロジェクトもタスクも無い（answer_directly の後の差し戻しなど）→ 段階 1 からやり直す
//   - 全部終わっているのに差し戻しコメントがある（review → 差し戻し）→ 最新ラウンドのまとめ（段階 4）からやり直す
import type { RunnerInstructionState, Task } from "@baton/shared";

export type ResumePoint =
  | { stage: "route" }
  | { stage: "plan"; round: number }
  | { stage: "work"; round: number }
  | { stage: "review"; round: number; reopen: boolean }
  | { stage: "final"; round: number };

const FINISHED: Task["status"][] = ["done", "failed", "canceled"];

export function isFinished(t: Task): boolean {
  return FINISHED.includes(t.status);
}

export function decideResume(state: RunnerInstructionState): ResumePoint {
  const { instruction, tasks } = state;
  if (!state.routed || !instruction.title) return { stage: "route" };
  if (!state.project && tasks.length === 0) return { stage: "route" };

  const round = tasks.reduce((m, t) => Math.max(m, t.round), 1);
  const plan = tasks.find((t) => t.kind === "plan" && t.round === round);
  if (!plan || plan.status !== "done") return { stage: "plan", round };

  const works = tasks.filter((t) => t.kind === "work" && t.round === round);
  if (works.length === 0) return { stage: "plan", round };
  if (works.some((t) => !isFinished(t))) return { stage: "work", round };

  const review = tasks.find((t) => t.kind === "review" && t.round === round);
  if (!review || review.status !== "done") return { stage: "review", round, reopen: false };

  if (instruction.feedback && instruction.feedback.trim()) return { stage: "review", round, reopen: true };
  return { stage: "final", round };
}
