// Tomo status extension for Pi.
// Reports lifecycle and session identity to tomod over its Unix socket.
// It adds no UI and does nothing outside a Tomo pane.

const paneId = process.env.TOMO_PANE_ID
const socketPath = process.env.TOMO_SOCKET

type Ctx = { sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } }

function sessionInfo(ctx: Ctx | undefined): Record<string, string> {
  const sm = ctx?.sessionManager
  const id = sm?.getSessionId?.()
  const file = sm?.getSessionFile?.()
  const out: Record<string, string> = {}
  if (typeof id === "string" && id) out.session_id = id
  if (typeof file === "string" && file) {
    try {
      if (require("fs").existsSync(file)) out.session_file = file
    } catch {}
  }
  return out
}

function report(event: string, ctx: Ctx | undefined, extra: Record<string, unknown> = {}): void {
  if (!paneId || !socketPath) return
  const payload = { event, ...sessionInfo(ctx), ...extra }
  const request = { id: 1, method: "agent_hook", params: { kind: "pi", pane_id: paneId, payload, at_ms: Date.now() } }
  try {
    const net = require("net")
    const conn = net.createConnection(socketPath)
    conn.setTimeout(1000)
    conn.on("error", () => {})
    conn.on("timeout", () => conn.destroy())
    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n")
      conn.end()
    })
  } catch {}
}

export default function tomoStatus(pi: any) {
  if (!paneId || !socketPath) return
  pi.on("session_start", async (_e: unknown, ctx: Ctx) => report("session_start", ctx))
  pi.on("agent_start", async (_e: unknown, ctx: Ctx) => report("agent_start", ctx))
  pi.on("agent_settled", async (_e: unknown, ctx: Ctx) => report("agent_settled", ctx))
  pi.on("ui_prompt_start", async (e: { kind?: string; title?: string }, ctx: Ctx) => report("ui_prompt_start", ctx, { kind: e?.kind, title: e?.title }))
  pi.on("ui_prompt_end", async (_e: unknown, ctx: Ctx) => report("ui_prompt_end", ctx))
  pi.on("turn_end", async (_e: unknown, ctx: Ctx) => report("turn_end", ctx))
  pi.on("session_shutdown", async (e: { reason?: string }, ctx: Ctx) => report("session_shutdown", ctx, { reason: e?.reason }))
}
