import { Drama, Hexagon, Pi, TerminalSquare } from "lucide-react";
import {
  siAnthropic,
  siBun,
  siClaude,
  siCmake,
  siDeno,
  siDocker,
  siGit,
  siGnubash,
  siGo,
  siNextdotjs,
  siNodedotjs,
  siNpm,
  siPnpm,
  siPython,
  siRuby,
  siRust,
  siStorybook,
  siTauri,
  siVim,
  siVite,
  siVitest,
  siYarn,
  siZsh,
} from "simple-icons";
import type { AgentKind } from "./types";

type Brand = { path: string; title: string };

/** Ordered: the first match wins. Command lines mention wrappers before the tool, so specific tools come first. */
const BY_COMMAND: [RegExp, Brand][] = [
  [/\bvitest\b/, siVitest],
  [/\bvite\b/, siVite],
  [/\bnext\b/, siNextdotjs],
  [/\bstorybook\b/, siStorybook],
  [/\btauri\b/, siTauri],
  [/\bpnpm\b/, siPnpm],
  [/\byarn\b/, siYarn],
  [/\bnpm\b|\bnpx\b/, siNpm],
  [/\bbun\b/, siBun],
  [/\bdeno\b/, siDeno],
  [/\bnode\b/, siNodedotjs],
  [/\bcargo\b|\brustc\b|\brust-analyzer\b/, siRust],
  [/\bpython3?\b|\buvicorn\b|\bpytest\b|\bpip3?\b|\buv\b/, siPython],
  [/\bruby\b|\bbundle\b|\brails\b/, siRuby],
  [/\bgo\b/, siGo],
  [/\bdocker\b|\bcompose\b/, siDocker],
  [/\bcmake\b/, siCmake],
  [/\bgit\b|\bgh\b/, siGit],
  [/\bn?vim\b/, siVim],
  [/\bzsh\b/, siZsh],
  [/\bbash\b|\bsh\b/, siGnubash],
];

const BY_AGENT: Record<AgentKind, Brand | null> = { claude: siClaude ?? siAnthropic, codex: null, pi: null };

export function brandFor(agent: AgentKind | null | undefined, cmd: string | null | undefined): Brand | null {
  if (agent) return BY_AGENT[agent];
  const text = (cmd ?? "").toLowerCase();
  return BY_COMMAND.find(([re]) => re.test(text))?.[1] ?? null;
}

/** A small brand mark for whatever runs in a pane: the agent, or the newest child of the shell. */
export function ProcessIcon({ agent, cmd, size = 12, className }: { agent?: AgentKind | null; cmd?: string | null; size?: number; className?: string }) {
  const box = { width: size, height: size };
  const cls = className ? `icon proc-icon ${className}` : "icon proc-icon";
  if (agent === "pi") return <Pi className={cls} style={box} aria-label="Pi" />;
  if (agent === "codex") return <Hexagon className={cls} style={box} aria-label="Codex" />;
  if (/\bplaywright\b/.test((cmd ?? "").toLowerCase())) return <Drama className={cls} style={box} aria-label="Playwright" />;
  const brand = brandFor(agent, cmd);
  if (!brand) return <TerminalSquare className={cls} style={box} aria-hidden />;
  return (
    <svg className={cls} viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={brand.title} style={box}>
      <path d={brand.path} fill="currentColor" />
    </svg>
  );
}
