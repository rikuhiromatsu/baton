// テストで使う fixture。api は画面と同じ Cookie（storageState）で API を呼ぶ。
// 初回の案内（D-38）は既定で見終わった扱いにする（各テストの操作をふさがないため）。案内そのものは E18 で確かめる
import { test as base } from "@playwright/test";
import { BatonApi } from "./api.ts";

export const ONBOARDED_KEY = "baton:onboarded";

export const test = base.extend<{ api: BatonApi; showOnboarding: boolean }>({
  showOnboarding: [false, { option: true }],
  context: async ({ context, showOnboarding }, use) => {
    if (!showOnboarding) {
      await context.addInitScript((key) => {
        try {
          localStorage.setItem(key, "1");
        } catch {
          // about:blank などでは使えない
        }
      }, ONBOARDED_KEY);
    }
    await use(context);
  },
  api: async ({ context }, use) => {
    await use(new BatonApi(context.request));
  },
});

export { expect } from "@playwright/test";
