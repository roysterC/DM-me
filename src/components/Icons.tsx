import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

const Stroke = ({ size = 24, children, strokeWidth = 1.8, ...rest }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

export const IconCamera = (p: P) => (
  <Stroke {...p}>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </Stroke>
);
export const IconImage = (p: P) => (
  <Stroke {...p}>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="9" cy="9" r="1.8" />
    <path d="M21 15.5l-5-5L5.5 21" />
  </Stroke>
);
export const IconClose = (p: P) => (
  <Stroke strokeWidth={2.2} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Stroke>
);
export const IconInfo = (p: P) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Stroke>
);
export const IconOnce = (p: P) => (
  <Stroke strokeWidth={2} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M10.5 9.5L12.5 8v8" />
  </Stroke>
);
export const IconReplay = (p: P) => (
  <Stroke strokeWidth={2} {...p}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7" />
    <path d="M4 4v4h4" />
  </Stroke>
);
export const IconKeep = (p: P) => (
  <Stroke strokeWidth={2} {...p}>
    <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />
  </Stroke>
);
export const IconOpened = (p: P) => (
  <Stroke strokeWidth={2} {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M4 4l16 16" />
  </Stroke>
);
export const IconArrow = (p: P) => (
  <Stroke strokeWidth={2.2} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Stroke>
);
export const IconDownload = (p: P) => (
  <Stroke strokeWidth={1.9} {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Stroke>
);
export const IconFlip = (p: P) => (
  <Stroke strokeWidth={1.9} {...p}>
    <path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3" />
    <path d="M4 4v4h4M20 20v-4h-4" />
  </Stroke>
);
export const IconHeart = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Stroke {...p} fill={filled ? '#FF3040' : 'none'} stroke={filled ? '#FF3040' : 'currentColor'}>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  </Stroke>
);
export const IconSend = (p: P) => (
  <Stroke {...p}>
    <path d="M21 3L10 14" />
    <path d="M21 3l-7 18-4-7-7-4z" />
  </Stroke>
);
export const IconBack = (p: P) => (
  <Stroke strokeWidth={2} {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Stroke>
);
