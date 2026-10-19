// F11 メンバーへの追加の依頼（D-54・5.6）: 詳細のメンバーのタブでは入力欄が「追加の依頼」になり、/api/sessions/:id/messages に送る
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { API_PATHS, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { sendToSession } from "../../src/web/api/messages.ts";
import { Composer } from "../../src/web/components/Composer.tsx";
import { composerTarget, parseRoute } from "../../src/web/lib/target.ts";
import { useDraft } from "../../src/web/state/draft.ts";
import { outboxForSession, useOutbox } from "../../src/web/state/outbox.ts";
import { json, makeQc, recordingTransport, Wrap } from "./helpers.tsx";

beforeEach(() => {
  useOutbox.setState({ items: {} });
  useDraft.setState({ texts: {} });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

describe("F11 追加の依頼", () => {
  it("sendToSession は clientId 付きで送り、届くまでそのセッションの送信待ちに出る", async () => {
    const qc = makeQc();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = recordingTransport(async () => {
      await gate;
      return json(202, { input: {} });
    });
    const clientId = sendToSession(qc, "s1", "i1", "見出しも付けて")!;
    expect(outboxForSession(useOutbox.getState().items, "s1").map((o) => o.body)).toEqual(["見出しも付けて"]);
    release();
    await waitFor(() => expect(useOutbox.getState().items[clientId]).toBeUndefined());
    expect(calls[0]!.path).toBe(API_PATHS.sessionMessages("s1"));
    expect(calls[0]!.body).toEqual({ clientId, body: "見出しも付けて" });
  });

  it("メンバーのタブの入力欄は followup の testid と「追加の依頼」の aria-label で、送るとセッションへ", async () => {
    const { calls } = recordingTransport(() => json(202, { input: {} }));
    const target = composerTarget(parseRoute("/i/i1"), {
      leaderThreadIdOf: () => null,
      projectNameOf: () => null,
      detailTarget: { instructionId: "i1", role: "member", sessionId: "s1", running: true },
      chipCleared: null,
    })!;
    render(
      <Wrap qc={makeQc()}>
        <Composer target={target} />
      </Wrap>,
    );
    const input = screen.getByTestId(TESTIDS.followupInput) as HTMLTextAreaElement;
    expect(input.getAttribute("aria-label")).toBe(UI_TEXT_V2.composer.followupAria);
    expect(screen.getByTestId(TESTIDS.threadTarget).textContent).toContain(UI_TEXT_V2.composer.followupAria);
    fireEvent.change(input, { target: { value: "テストも足して" } });
    fireEvent.click(screen.getByTestId(TESTIDS.followupSend));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.path).toBe(API_PATHS.sessionMessages("s1"));
  });
});
