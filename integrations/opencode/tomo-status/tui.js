// Tomo status: reports what this OpenCode TUI does to the Tomo pane that runs it. Inside a Tomo pane only,
// where TOMO_PANE_ID and TOMO_BIN are set; anywhere else it does nothing. It runs in the TUI, not in the shared
// OpenCode server, because only the TUI process knows its pane. The server sends the events of every TUI to
// every TUI, so it reports only the sessions that this TUI shows. Each report goes through `tomo hook opencode`,
// which keeps the event in a spool while the Tomo daemon is down.
import { spawn, spawnSync } from "node:child_process"

const pane = process.env.TOMO_PANE_ID
const bin = process.env.TOMO_BIN

const argvSession = (() => {
  const args = process.argv
  const at = args.findIndex((a) => a === "--session" || a === "-s")
  if (at >= 0) return args[at + 1]
  return args.find((a) => a.startsWith("--session="))?.slice("--session=".length)
})()

let queue = Promise.resolve()

function send(payload) {
  const body = JSON.stringify(payload)
  queue = queue.then(
    () =>
      new Promise((resolve) => {
        try {
          const child = spawn(bin, ["hook", "opencode"], { stdio: ["pipe", "ignore", "ignore"] })
          child.on("error", () => resolve())
          child.on("close", () => resolve())
          child.stdin.on("error", () => {})
          child.stdin.end(body)
        } catch {
          resolve()
        }
      }),
  )
}

function sendNow(payload) {
  try {
    spawnSync(bin, ["hook", "opencode"], { input: JSON.stringify(payload), timeout: 2000, stdio: ["pipe", "ignore", "ignore"] })
  } catch {}
}

const clip = (text) => (typeof text === "string" ? text.split(/\s+/).join(" ").slice(0, 300) : undefined)

export default {
  id: "tomo.status",
  setup(context) {
    if (!pane || !bin) return
    const parents = new Map()
    const rootOf = (id) => {
      let at = id
      for (let i = 0; i < 32; i++) {
        const parent = parents.get(at) ?? context.data.session.get(at)?.parentID
        if (!parent) return at
        at = parent
      }
      return at
    }
    const owned = (root) => {
      if (root === argvSession) return true
      const route = context.ui.router.current()
      if (route?.type === "session" && route.sessionID === root) return true
      try {
        return context.ui.tabs.list().some((t) => t.sessionID === root)
      } catch {
        return false
      }
    }
    const report = (event, sessionID, extra = {}) => {
      if (!sessionID) return
      const root = rootOf(sessionID)
      if (!owned(root)) return
      send({ event, session_id: root, ...(root === sessionID ? {} : { agent_id: sessionID }), ...extra })
    }
    const on = (type, handler) => context.data.on(type, (event) => handler(event.data ?? {}))

    if (argvSession) send({ event: "ready", session_id: argvSession })

    const off = [
      on("session.created", (d) => {
        if (!d.parentID) return
        parents.set(d.sessionID, d.parentID)
        report("subagent", d.sessionID, { agent_type: d.agent, description: clip(d.title) })
      }),
      on("session.execution.started", (d) => report("started", d.sessionID)),
      on("session.execution.succeeded", (d) => report("succeeded", d.sessionID)),
      on("session.execution.failed", (d) => report("failed", d.sessionID, { error: clip(d.error?.message) })),
      on("session.execution.interrupted", (d) => report("interrupted", d.sessionID, { reason: d.reason })),
      on("permission.asked", (d) =>
        report("permission", d.sessionID, { action: d.action, resource: clip((d.resources ?? []).join(" ")), message: clip(d.message) }),
      ),
      on("permission.replied", (d) => report("answered", d.sessionID)),
      on("form.created", (d) => report("question", d.form?.sessionID, { question: clip(d.form?.fields?.[0]?.description ?? d.form?.title) })),
      on("form.replied", (d) => report("answered", d.sessionID)),
      on("form.cancelled", (d) => report("answered", d.sessionID)),
    ]

    const marker = Symbol.for("tomo.status.exit")
    if (!globalThis[marker]) {
      globalThis[marker] = true
      process.once("exit", () => {
        const route = context.ui.router.current()
        sendNow({ event: "exit", session_id: route?.type === "session" ? route.sessionID : argvSession })
      })
    }
    return () => off.forEach((stop) => stop())
  },
}
