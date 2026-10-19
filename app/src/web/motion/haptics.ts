// 触覚（設計書 7.6）。出なくても視覚の反応で成り立つので、失敗は無視する。
let switchLabel: HTMLLabelElement | null = null;

function iosSwitch(): HTMLLabelElement | null {
  if (typeof document === "undefined") return null;
  if (switchLabel?.isConnected) return switchLabel;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
  const input = document.createElement("input");
  input.type = "checkbox";
  // iOS 18 以降の Safari は switch 属性付きのチェックボックスの切り替えで触覚を出す
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  switchLabel = label;
  return label;
}

export function haptic(): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(8);
      return;
    }
    iosSwitch()?.click();
  } catch {
    // 触覚は「出れば良い」
  }
}
