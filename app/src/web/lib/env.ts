// 端末の性質の判定
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** ?mock=1 のときだけ true（main.tsx が起動時に一度だけ決める） */
let mockMode = false;
export function setMockMode(on: boolean): void {
  mockMode = on;
}
export function isMockMode(): boolean {
  return mockMode;
}

/** モックが登録する操作（ログイン画面から呼ぶ）。本番では空のまま */
export type MockHooks = { login?: () => void };
const mockHooks: MockHooks = {};
export function registerMockHooks(h: MockHooks): void {
  Object.assign(mockHooks, h);
}
export function getMockHooks(): MockHooks {
  return mockHooks;
}
