// ランナー用の状態変更 API の共通検査（設計書 4.3）: その指示を今そのランナーが握っていること
import { getInstructionRow } from "../../db/instructions.ts";
import type { InstructionRow } from "../../db/rows.ts";
import { conflict, notFound } from "../../lib/errors.ts";

export async function requireLease(db: D1Database, instructionId: string, runnerId: string): Promise<InstructionRow> {
  const row = await getInstructionRow(db, instructionId);
  if (!row) throw notFound("instruction not found");
  if (row.status !== "running" || row.lease_runner_id !== runnerId) {
    throw conflict("lease not held", { status: row.status });
  }
  return row;
}

/** UPDATE の WHERE に足す lease の条件 */
export const LEASE_WHERE = "status = 'running' AND lease_runner_id = ?";
