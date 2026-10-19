// F18 設定（13.10）: 外観の切り替え、通知（iOS のタブでは案内の 1 行、許可して購読）、秘書のトークン（本体は 1 回だけ表示）、役割（見るだけ）
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BOT_TOKEN_PREFIX, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { pushSupportOf, setPushDriver } from "../../src/web/lib/push.ts";
import { setMedia } from "./setup.ts";
import { bootApp, disposeApp, stubPush } from "./helpers.tsx";

afterEach(() => {
  disposeApp();
  setMedia("(min-width: 1280px)", false);
  setMedia("(min-width: 1024px)", false);
  delete document.documentElement.dataset.theme;
});

describe("F18 設定", () => {
  it("通知が使えるかの判定: iOS は ホーム画面に追加した PWA の中だけ", () => {
    const base = { hasPushManager: true, hasServiceWorker: true, hasNotification: true };
    expect(pushSupportOf({ ...base, ios: true, standalone: false })).toBe("ios-needs-install");
    expect(pushSupportOf({ ...base, ios: true, standalone: true })).toBe("supported");
    expect(pushSupportOf({ ...base, ios: false, standalone: false })).toBe("supported");
    expect(pushSupportOf({ ...base, hasPushManager: false, ios: false, standalone: false })).toBe("unsupported");
  });

  it("秘書のトークン: 名前とスコープで発行 → 本体は 1 回だけ表示（画面を開き直すと出ない）", async () => {
    const app = await bootApp("/settings");
    await screen.findByTestId(TESTIDS.settings);
    const before = (await screen.findAllByTestId(TESTIDS.botTokenItem)).length;
    // スコープのチェックボックス（読む・COO に送る・回答案）
    for (const s of [UI_TEXT_V2.settings.scopeRead, UI_TEXT_V2.settings.scopeMessage, UI_TEXT_V2.settings.scopePropose]) {
      expect((screen.getByRole("checkbox", { name: s }) as HTMLInputElement).checked).toBe(true);
    }
    // 名前が空のままでは発行しない
    fireEvent.click(screen.getByTestId(TESTIDS.botTokenCreate));
    expect(screen.queryByTestId(TESTIDS.botTokenValue)).toBeNull();
    fireEvent.change(screen.getByLabelText(UI_TEXT_V2.settings.name), { target: { value: "Grok テスト" } });
    fireEvent.click(screen.getByRole("checkbox", { name: UI_TEXT_V2.settings.scopePropose }));
    fireEvent.click(screen.getByTestId(TESTIDS.botTokenCreate));
    const value = (await screen.findByTestId(TESTIDS.botTokenValue)) as HTMLInputElement;
    expect(value.value.startsWith(BOT_TOKEN_PREFIX)).toBe(true);
    expect(screen.getByText(UI_TEXT_V2.settings.shownOnce)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId(TESTIDS.botTokenItem).length).toBe(before + 1));
    const created = [...app.backend.botTokens].find((t) => t.name === "Grok テスト")!;
    expect(created.scopes).toEqual(["read", "message"]);
    // 開き直すと本体は出ない
    await act(() => app.router.navigate({ to: "/org" }));
    await waitFor(() => expect(screen.queryByTestId(TESTIDS.settings)).toBeNull(), { timeout: 4000 });
    await act(() => app.router.navigate({ to: "/settings" }));
    await screen.findByTestId(TESTIDS.settings);
    expect(screen.queryByTestId(TESTIDS.botTokenValue)).toBeNull();
    // 失効
    const item = (await screen.findAllByTestId(TESTIDS.botTokenItem)).find((x) => x.textContent?.includes("Grok テスト"))!;
    fireEvent.click(within(item).getByTestId(TESTIDS.botTokenRevoke));
    await waitFor(() => expect(created.revokedAt).not.toBeNull());
    // 記録（監査ログ）
    const grok = (await screen.findAllByTestId(TESTIDS.botTokenItem)).find((x) => x.textContent?.includes("Grok 秘書"))!;
    fireEvent.click(within(grok).getByText(UI_TEXT_V2.settings.audit));
    expect((await within(grok).findAllByTestId(TESTIDS.botAuditItem)).length).toBeGreaterThan(0);
  });

  it("通知: スイッチで許可を求めて購読し、端末の一覧に出る", async () => {
    const app = await bootApp("/settings");
    await screen.findByTestId(TESTIDS.settings);
    const before = app.backend.pushSubs.length;
    fireEvent.click(await screen.findByTestId(TESTIDS.pushToggle));
    await waitFor(() => expect(app.backend.pushSubs.length).toBe(before + 1));
    await waitFor(() => expect(screen.getByTestId(TESTIDS.pushToggle).getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(screen.getAllByTestId(TESTIDS.pushDevice).length).toBe(before + 1));
  });

  it("iOS の Safari のタブでは、スイッチの代わりに案内の 1 行", async () => {
    await bootApp("/settings");
    setPushDriver({ ...stubPush, support: () => "ios-needs-install" });
    cleanup();
    const app = await bootApp("/settings");
    setPushDriver({ ...stubPush, support: () => "ios-needs-install" });
    await act(() => app.router.navigate({ to: "/org" }));
    await act(() => app.router.navigate({ to: "/settings" }));
    expect((await screen.findByTestId(TESTIDS.pushIosHint)).textContent).toBe(UI_TEXT_V2.settings.iosHint);
    expect(screen.queryByTestId(TESTIDS.pushToggle)).toBeNull();
  });

  it("外観: ダークに固定すると html の data-theme が dark、自動に戻すと外れる", async () => {
    await bootApp("/settings");
    const options = await screen.findAllByTestId(TESTIDS.themeOption);
    expect(options.map((o) => o.getAttribute("data-value"))).toEqual(["auto", "light", "dark"]);
    fireEvent.click(options[2]!);
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(options[0]!);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
