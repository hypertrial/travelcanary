import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "attention"
  | "check"
  | "chevron"
  | "clear"
  | "clock"
  | "close"
  | "coverage"
  | "external"
  | "home"
  | "install"
  | "list"
  | "map"
  | "menu"
  | "minus"
  | "plus"
  | "search"
  | "unknown";

const paths: Record<IconName, ReactNode> = {
  attention: <><path d="M12 3.5 21 20H3L12 3.5Z" /><path d="M12 9v5" /><path d="M12 17.2h.01" /></>,
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  clear: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5l3.25 2" /></>,
  close: <><path d="m6.5 6.5 11 11" /><path d="m17.5 6.5-11 11" /></>,
  coverage: <><path d="M12 3.5 4.5 7v5.2c0 4 3 7.1 7.5 8.3 4.5-1.2 7.5-4.3 7.5-8.3V7L12 3.5Z" /><path d="M9.5 12h5" /></>,
  external: <><path d="M13 5h6v6" /><path d="m19 5-8 8" /><path d="M17 13v5.5H5.5v-12H11" /></>,
  home: <><path d="m4 11 8-7 8 7" /><path d="M6.5 9.5V20h11V9.5" /><path d="M10 20v-6h4v6" /></>,
  install: <><path d="M12 3v11" /><path d="m8 10 4 4 4-4" /><path d="M5 17v3h14v-3" /></>,
  list: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>,
  map: <><path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Z" /><path d="M9 4v14" /><path d="M15 6v14" /></>,
  menu: <><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></>,
  minus: <path d="M5 12h14" />,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4 4" /></>,
  unknown: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9.3a2.5 2.5 0 0 1 4.8 1c0 1.9-2.6 2.1-2.6 4" /><path d="M12 17.5h.01" /></>,
};

export function UiIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>{paths[name]}</svg>;
}
