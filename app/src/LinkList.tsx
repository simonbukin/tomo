import type { MouseEvent } from "react";
import { copyText, openExternalUrl } from "./actions";
import type { WorktreeLink } from "./addons/types";
import type { MenuItem } from "./components/ui";
import type { LinkGroup } from "./linkGroups";
import { openMenu } from "./MenuHost";
import { durationLabel } from "./previewModel";

export function linkMenu(link: WorktreeLink): MenuItem[] {
  const url = link.url;
  return [
    ...(url ? [{ label: "Open", run: () => openExternalUrl(url) }, { label: "Copy link", run: () => copyText(url, "Link") }] : []),
    { label: `Copy ${link.text}`, run: () => copyText(link.text, link.text) },
  ];
}

function open(link: WorktreeLink) {
  return (e: MouseEvent) => {
    e.preventDefault();
    if (link.url) openExternalUrl(link.url);
  };
}

function LinkLine({ link, now, sub, why }: { link: WorktreeLink; now: number; sub?: boolean; why: boolean }) {
  const Icon = link.icon;
  return (
    <a className={sub ? "link-line link-sub" : "link-line"} href={link.url} onClick={open(link)} onContextMenu={(e) => openMenu(e, linkMenu(link))}>
      <span className="link-icon"><Icon className="wt-link-icon" style={{ color: link.color }} /></span>
      <span className="link-text">
        <span className="link-id">{link.text}</span>
        <span className="link-title">{link.title}</span>
        {link.facts.map((f) => (
          <span key={f.text} className={f.bad ? "link-fact wt-tone-bad" : "link-fact"}>{` · ${f.text}`}</span>
        ))}
        {link.current && <span className="link-now">this branch</span>}
        {why && link.why && <span className="link-why">{link.why}</span>}
      </span>
      <span className="link-when">{link.touchedMs ? durationLabel(link.touchedMs, now) : ""}</span>
    </a>
  );
}

/** The links of a worktree, the newest first, a ticket's pull requests under it. A click opens a link; a right click offers its menu. */
export function LinkList({ groups, why = false, now = Date.now() }: { groups: LinkGroup[]; why?: boolean; now?: number }) {
  return (
    <div className="link-list">
      {groups.map(({ head, children }) => (
        <div key={head.id} className="link-group">
          <LinkLine link={head} now={now} why={why} />
          {children.map((c) => <LinkLine key={c.id} link={c} now={now} why={why} sub />)}
        </div>
      ))}
    </div>
  );
}
