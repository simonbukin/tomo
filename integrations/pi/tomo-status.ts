// Tomo status extension for Pi.
// Reports lifecycle, questions, subagents, and session identity to tomod over its Unix socket.
// It adds no UI and does nothing outside a Tomo pane.

import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

const paneId = process.env.TOMO_PANE_ID
const socketPath = process.env.TOMO_SOCKET
const dataDir = process.env.TOMO_DATA_DIR

// A subagent tool starts child `pi` processes that inherit the pane's environment. Only the first Pi of the pane
// reports, so a child cannot end or finish the parent's turn.
const OWNER = "TOMO_PI_PID"
const nested = !!process.env[OWNER] && process.env[OWNER] !== String(process.pid)
if (!nested) process.env[OWNER] = String(process.pid)

const SPOOL_MAX_BYTES = 1024 * 1024
const FIELD_MAX = 1000
const SEND_TIMEOUT_MS = 1000
const SUBAGENT_TOOLS = new Set(["subagent"])

type Ctx = {
  sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown }
  isIdle?: () => boolean
}

function sessionInfo(ctx: Ctx | undefined): Record<string, string> {
  const sm = ctx?.sessionManager
  const id = sm?.getSessionId?.()
  const file = sm?.getSessionFile?.()
  const out: Record<string, string> = {}
  if (typeof id === "string" && id) out.session_id = id
  if (typeof file === "string" && file && fs.existsSync(file)) out.session_file = file
  return out
}

const clip = (text: unknown) => (typeof text === "string" ? text.split(/\s+/).join(" ").slice(0, FIELD_MAX) : undefined)

// The same line that `tomo hook` writes when the daemon is down; the daemon replays the spool when it starts.
function spool(params: Record<string, unknown>): void {
  if (!dataDir) return
  try {
    const file = path.join(dataDir, "hook-spool.jsonl")
    if (fs.existsSync(file) && fs.statSync(file).size >= SPOOL_MAX_BYTES) return
    fs.appendFileSync(file, JSON.stringify({ method: "agent_hook", params }) + "\n")
  } catch {}
}

function deliver(params: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (delivered: boolean) => {
      if (settled) return
      settled = true
      if (!delivered) spool(params)
      resolve()
    }
    try {
      const conn = net.createConnection(socketPath!)
      conn.setTimeout(SEND_TIMEOUT_MS, () => {
        conn.destroy()
        done(false)
      })
      conn.on("error", () => done(false))
      conn.on("connect", () => conn.end(JSON.stringify({ id: 1, method: "agent_hook", params }) + "\n", () => done(true)))
    } catch {
      done(false)
    }
  })
}

// One send at a time, in order, so a subagent's start reaches Tomo after its launch. Pi waits for the promise that
// a handler returns, so the last event of a quit is sent before the process exits.
let queue: Promise<void> = Promise.resolve()

function report(event: string, ctx: Ctx | undefined, extra: Record<string, unknown> = {}): Promise<void> {
  const params = { kind: "pi", pane_id: paneId, payload: { event, ...sessionInfo(ctx), ...extra }, at_ms: Date.now() }
  queue = queue.then(() => deliver(params))
  return queue
}

type ToolEvent = { toolCallId?: string; toolName?: string; args?: { agent?: string; task?: string; tasks?: unknown[]; chain?: unknown[] } }
type Task = { agent?: string; task?: string }

// The tasks of one call of the subagent tool: one task, parallel `tasks`, or a `chain`. Each gets its own id.
function subagentsOf(e: ToolEvent): { id: string; agent: string; task?: string }[] {
  const args = e.args ?? {}
  const list = (Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.chain) ? args.chain : [args]) as Task[]
  return list.map((t, i) => ({ id: `${e.toolCallId}#${i}`, agent: t?.agent ?? "subagent", task: clip(t?.task) }))
}

export default function tomoStatus(pi: any) {
  if (!paneId || !socketPath || nested) return
  const loaded = Symbol.for("tomo.status.loaded")
  if ((globalThis as any)[loaded]) return
  ;(globalThis as any)[loaded] = true

  let outcome: { outcome: string; error?: string } = { outcome: "completed" }
  const running = new Map<string, string[]>()

  pi.on("session_start", (_e: unknown, ctx: Ctx) => report("session_start", ctx))
  pi.on("agent_start", (_e: unknown, ctx: Ctx) => {
    outcome = { outcome: "completed" }
    return report("agent_start", ctx)
  })
  pi.on("agent_end", (e: { messages?: { role?: string; stopReason?: string; errorMessage?: string }[] }) => {
    const last = [...(e?.messages ?? [])].reverse().find((m) => m?.role === "assistant")
    if (last?.stopReason === "aborted") outcome = { outcome: "aborted" }
    else if (last?.stopReason === "error") outcome = { outcome: "error", error: clip(last.errorMessage) }
  })
  pi.on("agent_settled", (_e: unknown, ctx: Ctx) => report("agent_settled", ctx, outcome))
  pi.on("ui_prompt_start", (e: { kind?: string; title?: string }, ctx: Ctx) => report("ui_prompt_start", ctx, { kind: e?.kind, title: clip(e?.title) }))
  pi.on("ui_prompt_end", (_e: unknown, ctx: Ctx) => report("ui_prompt_end", ctx, { running: ctx?.isIdle ? !ctx.isIdle() : true }))
  pi.on("tool_execution_start", (e: ToolEvent, ctx: Ctx) => {
    if (!SUBAGENT_TOOLS.has(e?.toolName ?? "") || !e.toolCallId) return
    const started = subagentsOf(e)
    running.set(e.toolCallId, started.map((s) => s.id))
    return Promise.all(started.map((s) => report("subagent_start", ctx, { agent_id: s.id, agent_type: s.agent, description: s.task }))).then(() => {})
  })
  pi.on("tool_execution_end", (e: ToolEvent, ctx: Ctx) => {
    const ids = e?.toolCallId ? running.get(e.toolCallId) : undefined
    if (!ids) return
    running.delete(e.toolCallId!)
    return Promise.all(ids.map((id) => report("subagent_stop", ctx, { agent_id: id }))).then(() => {})
  })
  pi.on("session_shutdown", (e: { reason?: string }, ctx: Ctx) => {
    if (e?.reason === "reload") (globalThis as any)[loaded] = false
    return report("session_shutdown", ctx, { reason: e?.reason })
  })
}
