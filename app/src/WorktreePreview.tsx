import { Star } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { Signal } from "./activityModel";
import { worktreeLinks } from "./addons";
import type { WorktreeLink } from "./addons/types";
import { agentStatus, GLYPH, subagentStatus } from "./glyphs";
import { durationLabel } from "./previewModel";
import { aboutDetails, gitDetails, homePath, hoverAgentLines, hoverAppLines, problemLines, type Detail, type Line } from "./rowModel";
import { StateMark, WorktreeMark } from "./StateMark";
import { agentsOf, formatBytes, useStore } from "./store";
import { KIND_LABEL, type Id, type Subagent, type Worktree } from "./types";
import { LineView, useRowInput } from "./WorktreeLines";
import "./styles/previews.css";

export function signalText(signal: Signal): string {
  switch (signal.kind) {
    case "attention":
      return `${GLYPH.needs} ${signal.text}`;
    case "crash":
      return `${GLYPH.failed} ${signal.text}`;
    case "agent":
      return signal.state === "waiting" ? `${GLYPH.needs} ${KIND_LABEL[signal.agent]} needs input` : `${GLYPH[agentStatus(signal.state) ?? "unknown"]} ${KIND_LABEL[signal.agent]}`;
    case "warn":
      return `⚠ ${formatBytes(signal.bytes)}`;
    case "addon":
      return [signal.glyph, signal.text].filter(Boolean).join(" ");
  }
}

const ORDER: Record<Subagent["state"], number> = { waiting: 0, dead: 1, working: 2, done: 3, unknown: 4, idle: 5, exited: 6 };

/** The live subagents of every agent in a worktree, most urgent first, then oldest first. */
export function subagentsOf(agents: { subagents?: Subagent[] }[]): Subagent[] {
  return agents.flatMap((a) => a.subagents ?? []).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.started_at_ms - b.started_at_ms);
}

/** Every subagent, indented under its worktree, one line each. With `flip`, each line is a `useFlip` item keyed under it. */
export function SubagentList({ worktreeId, flip }: { worktreeId: Id; flip?: string }) {
  const all = useStore((s) => subagentsOf(agentsOf(s, worktreeId)));
  if (!all.length) return null;
  return (
    <ul className="subagents" aria-label="subagents">
      {all.map((sub, i) => (
        <li key={sub.id ?? `launch-${i}`} data-flip={flip && `${flip}:${sub.id ?? `launch-${i}`}`} className={`subagent is-${sub.state}`}>
          <StateMark mark={subagentStatus(sub.state)} small />
          <span className="subagent-label">{sub.label}</span>
          <span className="subagent-desc">{sub.description}</span>
          <span className="subagent-age">{durationLabel(sub.started_at_ms)}</span>
        </li>
      ))}
    </ul>
  );
}

function Details({ rows }: { rows: Detail[] }) {
  return (
    <div className="wt-hover-kv">
      {rows.map((r) => (
        <Fragment key={r.key}>
          <span className="wt-hover-k">{r.key}</span>
          <span className={r.mono ? "wt-hover-v mono" : "wt-hover-v"}>
            {r.facts.map((f, i) => (
              <Fragment key={i}>
                {i > 0 && " "}
                <span className={f.tone && `wt-tone-${f.tone}`}>{f.text}</span>
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="wt-hover-sec">
      {title && <div className="wt-hover-title">{title}</div>}
      {children}
    </div>
  );
}

function Lines({ lines }: { lines: Line[] }) {
  return (
    <div className="wt-hover-lines">
      {lines.map((line, i) => (
        <span key={line.key} className={!line.sub && i > 0 ? "wt-hover-line wt-hover-gap" : "wt-hover-line"}>
          <LineView line={line} meta />
        </span>
      ))}
    </div>
  );
}

function LinkFacts({ link }: { link: WorktreeLink }) {
  const Icon = link.icon;
  return (
    <>
      <Icon className="wt-link-icon" style={{ color: link.color }} /> {link.text} {link.title}
      {link.facts.map((f) => (
        <Fragment key={f.text}>
          <span className="wt-tone-mute"> · </span>
          <span className={f.bad ? "wt-tone-bad" : "wt-tone-mute"}>{f.text}</span>
        </Fragment>
      ))}
    </>
  );
}

/** Everything the client knows about one worktree, for the hover card on a sidebar row or a rail square. */
export function WorktreePreview({ w }: { w: Worktree }) {
  const input = useRowInput(w);
  const links = useStore((s) => worktreeLinks(s, w));
  const now = Date.now();
  const problems = problemLines(input);
  const agents = hoverAgentLines(input, now);
  const apps = hoverAppLines(input.apps, now);
  return (
    <div className="wt-hover">
      <div className="wt-hover-head">
        <span className="wt-mcell">{w.archived_at_ms ? null : <WorktreeMark w={w} />}</span>
        <span className="wt-hover-name">
          {w.name}
          {w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}
        </span>
        <span className="wt-hover-when">{w.last_active_ms != null ? `${durationLabel(w.last_active_ms, now)} ago` : ""}</span>
        <span className="wt-hover-path">{homePath(w.path)}</span>
      </div>
      {problems.length > 0 && <Section title="problems"><Lines lines={problems} /></Section>}
      {agents.length > 0 && <Section title="agents"><Lines lines={agents} /></Section>}
      {apps.length > 0 && <Section title="apps"><Lines lines={apps} /></Section>}
      <Section title="git"><Details rows={gitDetails(w)} /></Section>
      {links.length > 0 && (
        <Section title="links">
          <div className="wt-hover-kv">
            {links.map((l) => (
              <Fragment key={l.id}>
                <span className="wt-hover-k">{l.label}</span>
                <span className="wt-hover-v"><LinkFacts link={l} /></span>
              </Fragment>
            ))}
          </div>
        </Section>
      )}
      <Section><Details rows={aboutDetails(w, now)} /></Section>
    </div>
  );
}
