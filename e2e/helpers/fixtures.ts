// テストで使う fixture。api は画面と同じ Cookie（storageState）で API を呼ぶ。
import { test as base } from "@playwright/test";
import { BatonApi } from "./api.ts";

export const test = base.extend<{ api: BatonApi }>({
  api: async ({ context }, use) => {
    await use(new BatonApi(context.request));
  },
});

export { expect } from "@playwright/test";
