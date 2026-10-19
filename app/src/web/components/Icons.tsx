// 線のアイコン（24×24、currentColor）。文字を増やさずに意味を伝える
import type { SVGProps } from "react";
import type { CeoAction } from "@baton/shared";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.2 4.2L19 7" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
  </Svg>
);
export const IconArchive = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5" />
    <path d="M5 9v8.5A2 2 0 0 0 7 19.5h10a2 2 0 0 0 2-2V9M10 13h4" />
  </Svg>
);
export const IconRetry = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4.5v4h4" />
  </Svg>
);
export const IconRestore = (p: P) => (
  <Svg {...p}>
    <path d="M9 14L4.5 9.5 9 5" />
    <path d="M4.5 9.5h9a6 6 0 0 1 0 12h-2" />
  </Svg>
);
export const IconSendBack = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 8.5L5 13l4.5 4.5" />
    <path d="M5 13h9.5a4.5 4.5 0 0 0 4.5-4.5V6" />
  </Svg>
);
export const IconQuestion = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.3c-.7.3-1.2 1-1.2 1.8v.3" />
    <path d="M12 17h.01" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M14 4.5h5.5V10M19.5 4.5L11 13" />
    <path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </Svg>
);
export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
    <path d="M13.5 3.5v5h5" />
  </Svg>
);
export const IconStop = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 15.5l7-7" />
  </Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  </Svg>
);
export const IconStar = (p: P) => (
  <Svg {...p}>
    <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />
  </Svg>
);
export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M10 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h4" />
    <path d="M14.5 8l4 4-4 4M18.5 12H9.5" />
  </Svg>
);
export const IconGauge = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 16a7.5 7.5 0 1 1 15 0" />
    <path d="M12 16l3.5-4.5" />
  </Svg>
);
export const IconGoogle = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

export const IconSidebar = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M9.5 4.5v15" />
  </Svg>
);
export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M5 17.5l-1 3 3.4-1.5A8 8 0 1 0 5 17.5z" />
  </Svg>
);
export const IconBranch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="6" r="2" />
    <circle cx="7" cy="18" r="2" />
    <circle cx="17" cy="8" r="2" />
    <path d="M7 8v8M17 10a6 6 0 0 1-6 6H9" />
  </Svg>
);
export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 10a5.5 5.5 0 0 1 11 0v3.5l1.5 2.5h-14l1.5-2.5z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6" />
  </Svg>
);
export const IconOrg = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3.5" width="6" height="4.5" rx="1.5" />
    <rect x="3.5" y="16" width="6" height="4.5" rx="1.5" />
    <rect x="14.5" y="16" width="6" height="4.5" rx="1.5" />
    <path d="M12 8v4M6.5 16v-2a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v2" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconSquare = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />
  </Svg>
);
export const IconAuto = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="M15.5 15.5L20 20" />
  </Svg>
);
export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M7.5 10l2.5 2-2.5 2M12.5 15h4" />
  </Svg>
);
export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.5 2.4 3.5 5.2 3.5 8.5s-1 6.1-3.5 8.5c-2.5-2.4-3.5-5.2-3.5-8.5s1-6.1 3.5-8.5z" />
  </Svg>
);
export const IconPencil = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 5.5l4 4L9 19H5v-4z" />
    <path d="M12.5 7.5l4 4" />
  </Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 4l1.6 4.8L18.5 10.5l-4.9 1.7L12 17l-1.6-4.8L5.5 10.5l4.9-1.7z" />
    <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);
export const IconCards = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="7.5" width="16" height="12" rx="2.5" />
    <path d="M6.5 4.5h11" />
  </Svg>
);
export const IconKey = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="14" r="4" />
    <path d="M11 11l8-8M16 6l2.5 2.5M14 8l2 2" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);
export const IconUnlink = (p: P) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7" />
    <path d="M4 4l16 16" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Svg>
);
export const IconBrain = (p: P) => (
  <Svg {...p}>
    <path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3 3 0 0 0 7.5 18 2.5 2.5 0 0 0 12 19.5v-15A2.5 2.5 0 0 0 9 4.5z" />
    <path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5 3 3 0 0 1-3 5 2.5 2.5 0 0 1-4.5 1.5" />
  </Svg>
);
export const IconListCheck = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 7l1.5 1.5L9 5.5M4.5 13l1.5 1.5L9 11.5M4.5 19l1.5 1.5L9 17.5M12 7h7.5M12 13h7.5M12 19h7.5" />
  </Svg>
);
export const IconHand = (p: P) => (
  <Svg {...p}>
    <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10.5V5a1.5 1.5 0 0 1 3 0v6M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.7-2.3L4 14.6a1.5 1.5 0 0 1 2.3-1.9L8 14.5" />
  </Svg>
);
export const IconDots = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);

/** 道具のアイコン（トランスクリプトの 1 行） */
export function ToolIcon({ tool, size = 15 }: { tool: string | null; size?: number }) {
  switch (tool) {
    case "Read":
      return <IconFile size={size} />;
    case "Grep":
    case "Glob":
      return <IconSearch size={size} />;
    case "Edit":
    case "NotebookEdit":
      return <IconPencil size={size} />;
    case "Write":
      return <IconFile size={size} />;
    case "Bash":
      return <IconTerminal size={size} />;
    case "WebFetch":
    case "WebSearch":
      return <IconGlobe size={size} />;
    case "Skill":
      return <IconSparkle size={size} />;
    case "TodoWrite":
      return <IconListCheck size={size} />;
    default:
      return <IconDots size={size} />;
  }
}

export function ActionIcon({ action, size = 22 }: { action: CeoAction | "open_decision"; size?: number }) {
  switch (action) {
    case "approve":
      return <IconCheck size={size} />;
    case "send_back":
      return <IconSendBack size={size} />;
    case "cancel":
      return <IconStop size={size} />;
    case "archive":
      return <IconArchive size={size} />;
    case "retry":
      return <IconRetry size={size} />;
    case "restore":
      return <IconRestore size={size} />;
    case "open_decision":
      return <IconQuestion size={size} />;
  }
}

/** Baton のマーク（アイコンと同じバトン形状） */
export function BatonMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="bm-body" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0A84FF" stopOpacity="0.92" />
          <stop offset="0.5" stopColor="#5E8BFF" stopOpacity="0.78" />
          <stop offset="1" stopColor="#AF52DE" stopOpacity="0.92" />
        </linearGradient>
        <linearGradient id="bm-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform="rotate(-38 32 32)">
        <rect x="9" y="26" width="46" height="12" rx="6" fill="url(#bm-body)" />
        <rect x="24" y="26" width="16" height="12" fill="#fff" opacity="0.22" />
        <rect x="10.5" y="27" width="43" height="5.5" rx="2.75" fill="url(#bm-sheen)" />
      </g>
    </svg>
  );
}
