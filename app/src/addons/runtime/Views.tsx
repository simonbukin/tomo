import { ArrowUpRight, Radio } from "lucide-react";
import { Button, HoverCard, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../../components/ui";
import type { RuntimeEndpoint } from "../../generated";
import { openMenu } from "../../MenuHost";
import { durationLabel } from "../../previewModel";
import { useStore } from "../../store";
import type { Id } from "../../types";
import type { SourceMarkProps, TopbarProps } from "../types";
import { endpointMenu, openIn } from "./commands";
import { byRank, endpointLabel, endpointSummary, endpointUrl, httpEndpoints, ofSource, primaryEndpoint, servesPage } from "./model";
import { endpointsOf } from "./state";

export function RuntimePreview({ endpoint: e, label }: { endpoint: RuntimeEndpoint; label: string }) {
  return (
    <div className="preview">
      <div className="preview-head">{label}</div>
      <div className="mono">
        {e.host}:{e.port}
      </div>
      <div className="muted">
        {endpointSummary(e)} · {e.process} · pid {e.pid}
      </div>
      <div className="muted">up {durationLabel(e.discovered_at_ms)}</div>
    </div>
  );
}

/** The port map of a worktree in its top bar: every listening port, pages first. It renders nothing while the worktree has no endpoint. */
export function RuntimePopover({ worktree: w }: TopbarProps) {
  const endpoints = useStore((s) => endpointsOf(s, w.id));
  if (endpoints.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Ports" />}>
        <Radio className="icon" />
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>ports</PopoverTitle>
        {byRank(endpoints).map((e) => (
          <div key={e.id} className="runtime-row" onContextMenu={(ev) => openMenu(ev, endpointMenu(w.id, e))}>
            <span className="runtime-label">{endpointLabel(e)}</span>
            <span className="mono">:{e.port}</span>
            <span className={servesPage(e) ? "mono" : "mono muted"}>{endpointSummary(e)}</span>
            {e.protocol === "tcp" ? <span /> : <Button size="sm" onClick={openIn(w.id, endpointUrl(e))}>open</Button>}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The arrow in the control of a pane source that serves HTTP. */
export function EndpointMark({ worktreeId, source }: SourceMarkProps) {
  const endpoint = useStore((s) => httpEndpoints(byRank(ofSource(endpointsOf(s, worktreeId), source)))[0] ?? null);
  if (!endpoint) return null;
  return (
    <HoverCard content={<RuntimePreview endpoint={endpoint} label={endpointLabel(endpoint)} />}>
      <span className="action-live">
        <ArrowUpRight className="icon" />
      </span>
    </HoverCard>
  );
}

/** The NOW signal line: the first HTTP endpoint, with an arrow and a hover preview. */
export function RuntimeSignal({ worktreeId }: { worktreeId: Id }) {
  const endpoint = useStore((s) => primaryEndpoint(s, worktreeId));
  if (!endpoint) return null;
  const label = endpointLabel(endpoint);
  return (
    <HoverCard content={<RuntimePreview endpoint={endpoint} label={label} />}>
      <span className="signal signal-runtime">
        {label} <ArrowUpRight className="icon" /> :{endpoint.port}
      </span>
    </HoverCard>
  );
}
