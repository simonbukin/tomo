import { appLines, worktreeLinks } from "./addons";
import { cx } from "./components/ui";
import { rowGroups, type Line, type RowGroups, type RowInput } from "./rowModel";
import { StateMark } from "./StateMark";
import { agentsOf, setRowError, useStore } from "./store";
import type { Worktree } from "./types";

/** Everything a row reads from the store. Each part keeps the identity of its items, so a quiet store change draws nothing. */
export function useRowInput(w: Worktree): RowInput {
  const agents = useStore((s) => agentsOf(s, w.id));
  const attention = useStore((s) => s.attention.filter((a) => a.worktree_id === w.id));
  const exits = useStore((s) => agents.map((a) => s.panes[a.pane_id]?.exit_code ?? null));
  const rssBytes = useStore((s) => s.resources[w.id]?.rss_bytes ?? null);
  const warnBytes = useStore((s) => s.config?.resource_warning_bytes ?? Infinity);
  const rowError = useStore((s) => s.rowErrors[w.id] ?? null);
  const apps = useStore((s) => appLines(s, w.id));
  const exitCodes = Object.fromEntries(agents.map((a, i) => [a.pane_id, exits[i] ?? null]));
  return { worktree: w, agents, attention, exitCodes, rssBytes, warnBytes, rowError, apps };
}

function LineText({ line }: { line: Line }) {
  return (
    <>
      {line.label && <b className="wt-line-label">{line.label}</b>}
      {line.kind && <span className="wt-line-kind">{line.kind}</span>}
      {line.text && <span className={line.tone && `wt-tone-${line.tone}`}>{line.text}</span>}
    </>
  );
}

/** One 20px line: the mark in the mark column and the text on the text edge, or one level in for a subagent. */
export function LineView({ line, meta = false, dismiss }: { line: Line; meta?: boolean; dismiss?: () => void }) {
  const mark = <StateMark mark={line.mark} title={line.title} small={line.sub} />;
  const press = dismiss && {
    role: "button",
    tabIndex: 0,
    title: "click to dismiss",
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      dismiss();
    },
    onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && dismiss(),
  };
  return (
    <span className={cx("wt-line", line.sub && "wt-line-sub")}>
      <span className="wt-mcell">{line.sub ? null : mark}</span>
      <span className="wt-line-text" {...press}>
        {line.sub ? (
          <>
            <span className="wt-smc">{mark}</span>
            <span>
              <LineText line={line} />
            </span>
          </>
        ) : (
          <LineText line={line} />
        )}
      </span>
      {meta && <span className="wt-line-meta">{line.meta}</span>}
    </span>
  );
}

/** The groups of a row in their fixed order: problems, agents with their subagents, apps. An empty group draws nothing. */
export function LineGroups({ w, groups, only }: { w: Worktree; groups: RowGroups; only?: readonly (keyof RowGroups)[] }) {
  const order = (only ?? (["problems", "agents", "apps"] as const)).filter((g) => groups[g].length > 0);
  return order.map((g) => (
    <span key={g} className={`wt-group wt-group-${g}`}>
      {groups[g].map((line) => <LineView key={line.key} line={line} dismiss={line.key === "row-error" ? () => setRowError(w.id, null) : undefined} />)}
    </span>
  ));
}

/** The lines of a worktree, for a surface that keeps its own outer layout, such as a Home card. */
export function WorktreeLines({ w, only }: { w: Worktree; only?: readonly (keyof RowGroups)[] }) {
  const groups = rowGroups(useRowInput(w));
  return <LineGroups w={w} groups={groups} only={only} />;
}

/** The links at the right of a name line, such as the pull request. With no addon there are none. */
export function WorktreeLinks({ w }: { w: Worktree }) {
  const links = useStore((s) => (w.archived_at_ms ? [] : worktreeLinks(s, w)));
  return links.map(({ id, icon: Icon, color, text, title }) => (
    <span key={id} className="wt-link" title={title}>
      <Icon className="wt-link-icon" style={{ color }} />
      {text}
    </span>
  ));
}
