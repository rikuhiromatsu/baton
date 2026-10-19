// localStorage の薄い包み。モックのときはキーを分ける（本物のデータと混ぜない）
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { isMockMode } from "../lib/env.ts";

const raw: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(prefixed(name));
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(prefixed(name), value);
    } catch {
      // 容量超過・プライベートモードは無視
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(prefixed(name));
    } catch {
      // 無視
    }
  },
};

export function prefixed(name: string): string {
  return isMockMode() ? `mock:${name}` : name;
}

export const appStorage = createJSONStorage(() => raw);
export const rawStorage = raw;
