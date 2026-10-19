// カードのフリック操作（v1 設計書 8.3）と、v2 の画面の左端からのスワイプ・長押し（DESIGN-v2 13.3・13.9・13.13）。
// - Chromium のタッチ端末: CDP の Input.dispatchTouchEvent（touchStart → touchMove × 8 → touchEnd）。
//   本物のタッチ入力として扱われ、pointer イベントやスクロールもブラウザが作る。
// - WebKit のタッチ端末: CDP が無いので PointerEvent（pointerType: "touch"）をページ内で順に dispatchEvent する。
// - デスクトップ: マウスのドラッグ。
// 速度は「距離 ÷ 所要時間」で作る。所要時間を 9 等分した間隔で動かす。
import type { Locator, Page } from "@playwright/test";
import { TESTIDS } from "@baton/shared";

export type SwipeMode = "cdp-touch" | "pointer-touch" | "mouse";

export type SwipeOptions = {
  /** 横方向の移動距離（px）。正の数で、向きは direction で決める */
  distance: number;
  /** 指を置いてから離すまでの時間（ms） */
  durationMs: number;
  /** 縦方向の移動量（px。上へは負）。斜めの動き（E14）に使う */
  dy?: number;
  /** 既定はブラウザと端末から自動で選ぶ */
  mode?: SwipeMode;
  /**
   * move の回数（既定 8）。headless Chromium は CDP のタッチを約 20ms おきにしか届けないので、
   * 速いフリックを作るときは回数を減らす
   */
  moves?: number;
  /** 各 move の直後に呼ぶ（動いている途中のカードの位置を測るため） */
  onStep?: (step: number) => Promise<void>;
};

const MOVES = 8;

/** data-testid="instruction-card" かつ data-id の一致するカード（v2 はカードの列・`指示` のシートの中。ui.ts の cardsPanel） */
export function cardById(scope: Page | Locator, id: string): Locator {
  return scope.locator(`[data-testid="${TESTIDS.instructionCard}"][data-id="${id}"]`);
}

export async function detectSwipeMode(page: Page): Promise<SwipeMode> {
  const browser = page.context().browser()?.browserType().name();
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches);
  if (!touch) return "mouse";
  return browser === "chromium" ? "cdp-touch" : "pointer-touch";
}

export async function swipeCard(
  page: Page,
  card: Locator,
  direction: "left" | "right",
  options: SwipeOptions,
): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) throw new Error("カードが画面にありません");
  const viewport = page.viewportSize();
  const maxX = (viewport?.width ?? box.x + box.width) - 2;
  const maxY = (viewport?.height ?? box.y + box.height) - 2;

  const sign = direction === "right" ? 1 : -1;
  // 移動しきっても画面の外に出ないように、動かす向きの反対側の端の近くから始める
  const startX = direction === "right" ? box.x + Math.min(24, box.width * 0.1) : Math.min(box.x + box.width, maxX) - Math.min(24, box.width * 0.1);
  const startY = box.y + box.height / 2;
  const dy = options.dy ?? 0;
  const moves = options.moves ?? MOVES;
  const points = Array.from({ length: moves }, (_, i) => {
    const t = (i + 1) / moves;
    return { x: clamp(startX + sign * options.distance * t, 1, maxX), y: clamp(startY + dy * t, 1, maxY) };
  });
  await gesture(page, { x: startX, y: startY }, points, options.durationMs, options.mode, options.onStep);
}

/**
 * 指を置いて points の順に動かして離す（CDP のタッチ・WebKit の PointerEvent・マウス）。
 * 所要時間を (points + 1) 等分した間隔で動かす。CDP のタッチには timestamp を付けて速度を再現する
 */
export async function gesture(
  page: Page,
  start: { x: number; y: number },
  points: readonly { x: number; y: number }[],
  durationMs: number,
  modeOpt?: SwipeMode,
  onStep?: (step: number) => Promise<void>,
): Promise<void> {
  const startX = start.x;
  const startY = start.y;
  const options = { onStep };
  const stepMs = durationMs / (points.length + 1);
  const mode = modeOpt ?? (await detectSwipeMode(page));

  if (mode === "cdp-touch") {
    const cdp = await page.context().newCDPSession(page);
    try {
      const touch = (x: number, y: number) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
      // CDP は届くまでに 40〜60ms かかることがあり、並列実行では速さが再現できない。
      // timestamp（秒）を指定して、イベントの時刻を指の動きどおりにする
      const base = Date.now() / 1000;
      const at = (i: number) => base + (i * stepMs) / 1000;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(startX, startY), timestamp: at(0) });
      for (const [i, p] of points.entries()) {
        await sleep(stepMs);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(p.x, p.y), timestamp: at(i + 1) });
        await options.onStep?.(i);
      }
      await sleep(stepMs);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: at(points.length + 1) });
    } finally {
      await cdp.detach().catch(() => {});
    }
    return;
  }

  if (mode === "mouse") {
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (const [i, p] of points.entries()) {
      await sleep(stepMs);
      await page.mouse.move(p.x, p.y);
      await options.onStep?.(i);
    }
    await sleep(stepMs);
    await page.mouse.up();
    return;
  }

  // pointer-touch（WebKit）: 時間の正確さのため、待ちもページの中で行う。
  // onStep を使う場合だけ、1 手ずつ Node 側から送る。
  if (options.onStep) {
    await dispatchPointer(page, "pointerdown", startX, startY);
    for (const [i, p] of points.entries()) {
      await sleep(stepMs);
      await dispatchPointer(page, "pointermove", p.x, p.y);
      await options.onStep(i);
    }
    await sleep(stepMs);
    const last = points[points.length - 1]!;
    await dispatchPointer(page, "pointerup", last.x, last.y);
    return;
  }
  await page.evaluate(
    async ({ start, points, stepMs }) => {
      const target = document.elementFromPoint(start.x, start.y);
      if (!target) throw new Error("指の下に要素がありません");
      const fire = (type: string, x: number, y: number) => {
        const down = type !== "pointerup";
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 0,
            buttons: down ? 1 : 0,
            width: 8,
            height: 8,
            pressure: down ? 0.5 : 0,
          }),
        );
      };
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      fire("pointerdown", start.x, start.y);
      for (const p of points) {
        await wait(stepMs);
        fire("pointermove", p.x, p.y);
      }
      await wait(stepMs);
      const last = points[points.length - 1]!;
      fire("pointerup", last.x, last.y);
    },
    { start: { x: startX, y: startY }, points, stepMs },
  );
}

/** 1 回分の PointerEvent をページに送る（最初の pointerdown の位置にある要素へ送り続ける） */
async function dispatchPointer(page: Page, type: string, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ type, x, y }) => {
      const w = window as unknown as { __batonSwipeTarget?: Element | null };
      if (type === "pointerdown") w.__batonSwipeTarget = document.elementFromPoint(x, y);
      const target = w.__batonSwipeTarget;
      if (!target) throw new Error("指の下に要素がありません");
      const down = type !== "pointerup";
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons: down ? 1 : 0,
          width: 8,
          height: 8,
          pressure: down ? 0.5 : 0,
        }),
      );
      if (type === "pointerup") w.__batonSwipeTarget = null;
    },
    { type, x, y },
  );
}

/** しきい値（min(120px, 幅 × 0.32)。設計書 7.6）を十分に超える、ゆっくりめの確実なフリック */
export async function flick(page: Page, card: Locator, direction: "left" | "right"): Promise<void> {
  const box = await card.boundingBox();
  const width = box?.width ?? 360;
  const distance = Math.min(Math.max(170, width * 0.5), 240, width - 60);
  await swipeCard(page, card, direction, { distance, durationMs: 320 });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 画面の左端（16px 以内）から右へのスワイプ（13.3・13.13）。ホームではドロワーを開き、リーダーのスレッドでは COO に戻る。
 * 指は x=4 から始める（カードのフリックは 16px より内側で始まるので衝突しない）
 */
export async function edgeSwipe(page: Page, opts: { distance?: number; durationMs?: number; y?: number } = {}): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 390, height: 844 };
  const y = opts.y ?? Math.round(viewport.height / 2);
  const distance = Math.min(opts.distance ?? 220, viewport.width - 10);
  const moves = 8;
  const points = Array.from({ length: moves }, (_, i) => ({ x: 4 + (distance * (i + 1)) / moves, y }));
  await gesture(page, { x: 4, y }, points, opts.durationMs ?? 280);
}

/** 長押し（組織図のエージェント → シート。13.9）。タッチは指を置いたまま待つ、デスクトップはマウスを押したまま待つ */
export async function longPress(page: Page, target: Locator, holdMs = 800): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("長押しする要素が画面にありません");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const mode = await detectSwipeMode(page);
  if (mode === "cdp-touch") {
    const cdp = await page.context().newCDPSession(page);
    try {
      const touch = [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch });
      await sleep(holdMs);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach().catch(() => {});
    }
    return;
  }
  if (mode === "mouse") {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(holdMs);
    await page.mouse.up();
    return;
  }
  await dispatchPointer(page, "pointerdown", x, y);
  await sleep(holdMs);
  await dispatchPointer(page, "pointerup", x, y);
}
