// 画面の上部バー（13.4・13.13）。モバイルは ドロワー｜相手と状態｜`指示`・リング・アバター、デスクトップは 相手と状態｜リング・点・アバター
import type { ReactNode } from "react";
import { TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { useQuota, useSession } from "../api/queries.ts";
import { useBreakpoint } from "../lib/media.ts";
import { useUi } from "../state/ui.ts";
import { CardsButton } from "./CardsPanel.tsx";
import { HeaderTools } from "./HeaderTools.tsx";
import { IconSidebar } from "./Icons.tsx";

type Props = {
  /** 左の戻る導線など（無ければモバイルはドロワーのボタン） */
  leading?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** 右の道具の前に足すもの */
  actions?: ReactNode;
  /** モバイルで `指示` のボタンを出す */
  cards?: boolean;
  className?: string;
};

export function DrawerButton() {
  return (
    <button
      type="button"
      className="header-button header-button--icon"
      data-testid={TESTIDS.sidebarToggle}
      aria-label={UI_TEXT_V2.sidebar.drawerAria}
      onClick={() => useUi.getState().setDrawerOpen(true)}
    >
      <IconSidebar size={20} />
    </button>
  );
}

export function ScreenHeader({ leading, title, sub, actions, cards = true, className = "" }: Props) {
  const bp = useBreakpoint();
  const session = useSession();
  const loggedIn = session.data !== undefined;
  const quota = useQuota(loggedIn);
  const narrow = bp === "narrow";
  return (
    <header className={`screen-header ${className}`.trim()}>
      <div className="screen-header__inner">
        <div className="screen-header__leading">{leading ?? (narrow ? <DrawerButton /> : null)}</div>
        <div className="screen-header__title">
          <div className="screen-header__title-main">{title}</div>
          {sub && <div className="screen-header__sub">{sub}</div>}
        </div>
        <div className="screen-header__trailing">
          {actions}
          {narrow && cards && <CardsButton />}
          <HeaderTools session={session.data} quota={quota.data} />
        </div>
      </div>
    </header>
  );
}
