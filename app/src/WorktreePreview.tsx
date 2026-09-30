import { Star } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { worktreeLinks } from "./addons";
import type { WorktreeLink } from "./addons/types";
import { durationLabel } from "./previewModel";
import { aboutDetails, gitDetails, homePath, hoverAgentLines, hoverAppLines, problemLines, rowGroups, type Detail, type Line } from "./rowModel";
import { useStore } from "./store";
import type { Worktree } from "./types";
import { LineView, RowMark, useRowInput } from "./WorktreeLines";
import "./styles/previews.css";

function Details({ rows }: { rows: Detail[] }) {
  return (
    <div className="wt-hover-kv">
      {rows.map((r) => (
        <Fragment key={r.key}>
          <span className="wt-hover-k">{r.key}</span>
          <span className="wt-hover-v">
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
        <span className="wt-mcell"><RowMark w={w} input={input} groups={rowGroups(input)} /></span>
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
