/**
 * Minimal SVG icon set for AntDesk
 * All icons: 16x16 default, stroke-based, currentColor
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const S = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function IconCalendar({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconEdit({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function IconTarget({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconSearch({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function IconSettings({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

export function IconPlus({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconRefresh({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

export function IconX({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconChevronDown({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconChevronLeft({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function IconCheck({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconMinimize({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconInbox({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  );
}

export function IconFolder({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

export function IconBriefcase({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </svg>
  );
}

export function IconHeart({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

export function IconBrain({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M12 3C8 3 5 6 5 9c0 1.5.5 2.8 1.4 3.9L5 16h14l-1.4-3.1C18.5 11.8 19 10.5 19 9c0-3-3-6-7-6z" />
      <path d="M9 16v2a3 3 0 006 0v-2" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconReport({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function IconStar({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function IconMoreHoriz({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconLock({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

export function IconUnlock({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 017.6-1.7" />
    </svg>
  );
}

export function IconEyeOff({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M17.9 17.9A10.7 10.7 0 0112 20C7 20 2.7 16.9 1 12c.7-2 1.9-3.7 3.5-5" />
      <path d="M9.9 4.2A10.2 10.2 0 0112 4c5 0 9.3 3.1 11 8a12 12 0 01-2.1 3.5" />
      <path d="M14.1 14.1A3 3 0 019.9 9.9" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

export function IconWindow({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="8" y1="4" x2="8" y2="9" />
    </svg>
  );
}

export function IconPower({ size = 16, ...p }: IconProps) {
  return (
    <svg {...S(size)} {...p}>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 11-12.8 0" />
    </svg>
  );
}
