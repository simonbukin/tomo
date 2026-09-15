import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, MessageSquarePlus, SendHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "../../components/ui";
import type { EvidenceBundle } from "../../generated";
import { agentsOf, errorText, failToast, recordDiagnostic, showStatus, useStore } from "../../store";
import { KIND_LABEL, type Id } from "../../types";
import type { BrowserToolbarProps } from "../types";

type Feedback = { count: number; markdown: string };
type FeedbackEvent = Feedback & { pane_id: Id; kind: "change" | "copy" | "submit" };

const INSTRUCTION = "Review and address this feedback.";
const NO_FEEDBACK: Feedback = { count: 0, markdown: "" };

const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

const hostFailed = (op: string) => (e: unknown) => recordDiagnostic("error", "browser", `${op}: ${errorText(e)}`);

const copyFeedback = (markdown: string) => void import("../../actions").then(({ copyText }) => copyText(markdown, "Feedback"));

/** Annotate, the note count, Copy feedback, and the Send menu of one browser pane. The page overlay reports through `browser://feedback`. */
export function AgentationToolbar({ paneId, worktreeId, url, setCovering }: BrowserToolbarProps) {
  const agents = useStore((s) => agentsOf(s, worktreeId));
  const [annotate, setAnnotate] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pageUrl, setPageUrl] = useState(url);
  if (url !== pageUrl) {
    setPageUrl(url);
    setFeedback(NO_FEEDBACK);
  }

  useEffect(() => {
    const off = listen<FeedbackEvent>("browser://feedback", (e) => {
      const { pane_id, kind, count, markdown } = e.payload;
      if (pane_id !== paneId) return;
      if (kind === "change") setFeedback({ count, markdown });
      if (kind === "copy") copyFeedback(markdown);
      if (kind === "submit") setMenuOpen(true);
    });
    return () => {
      off.then((stop) => stop());
    };
  }, [paneId]);

  const sendOpen = menuOpen && feedback.count > 0;
  useEffect(() => {
    setCovering(sendOpen);
  }, [sendOpen, setCovering]);

  const toggleAnnotate = () => {
    const enabled = !annotate;
    setAnnotate(enabled);
    invoke("browser_set_annotate", { paneId, enabled }).catch(hostFailed("browser_set_annotate"));
  };

  const send = async (agentPaneId: Id, label: string) => {
    const { count, markdown } = feedback;
    const bundle: EvidenceBundle = { source: "browser feedback", worktree_id: worktreeId, url, action_id: null, annotations: [], instruction: INSTRUCTION, markdown, note_count: count };
    try {
      await rpc("annotations_send", { pane_id: agentPaneId, bundle });
      setFeedback(NO_FEEDBACK);
      invoke("browser_clear_annotations", { paneId }).catch(hostFailed("browser_clear_annotations"));
      showStatus(`Sent ${notes(count)} to ${label}`);
    } catch (e) {
      failToast("Send failed")(e);
    }
  };

  const sendItems = (): MenuItem[] => [
    ...(agents.length ? agents.map((a) => ({ label: `${KIND_LABEL[a.kind]} — ${a.state}`, run: () => send(a.pane_id, KIND_LABEL[a.kind]) })) : [{ label: "no live agent in this worktree", disabled: true }]),
    { separator: true },
    { label: "Copy as markdown", run: () => copyFeedback(feedback.markdown) },
  ];

  return (
    <>
      <IconButton label={annotate ? "Stop annotating" : "Annotate"} className={annotate ? "browser-annotate-on" : undefined} aria-pressed={annotate} onClick={toggleAnnotate}>
        <MessageSquarePlus className="icon" />
      </IconButton>
      {feedback.count > 0 && (
        <>
          <span className="browser-count" title={notes(feedback.count)}>
            {feedback.count}
          </span>
          <IconButton label="Copy feedback" onClick={() => copyFeedback(feedback.markdown)}>
            <Copy className="icon" />
          </IconButton>
          <DropdownMenu open={sendOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger render={<IconButton label="Send feedback to an agent" />}>
              <SendHorizontal className="icon" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <MenuItems items={sendItems} />
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </>
  );
}
