import { Agentation, loadAnnotations, saveAnnotations, type Annotation } from "agentation";
import { createRoot, type Root } from "react-dom/client";
import { feedbackMarkdown } from "./markdown";

type FeedbackKind = "change" | "copy" | "submit";

declare global {
  interface Window {
    __tomoAgentation?: { set(enabled: boolean): void; clear(): void };
    __TAURI_INTERNALS__?: { invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> };
  }
}

function report(kind: FeedbackKind, count: number, markdown: string) {
  window.__TAURI_INTERNALS__?.invoke("browser_feedback", { kind, count, markdown }).catch(() => {});
}

function install() {
  let notes: Annotation[] = [];
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  const changed = (next: Annotation[]) => {
    notes = next;
    report("change", notes.length, feedbackMarkdown(location.href, document.title, notes));
  };

  const mount = () => {
    host = document.createElement("div");
    host.setAttribute("data-tomo-agentation", "");
    document.documentElement.appendChild(host);
    root = createRoot(host);
    root.render(
      <Agentation
        copyToClipboard={false}
        onAnnotationAdd={(a) => changed([...notes, a])}
        onAnnotationUpdate={(a) => changed(notes.map((n) => (n.id === a.id ? a : n)))}
        onAnnotationDelete={(a) => changed(notes.filter((n) => n.id !== a.id))}
        onAnnotationsClear={() => changed([])}
        onCopy={(markdown) => report("copy", notes.length, markdown)}
        onSubmit={(output, list) => report("submit", list.length, output)}
      />,
    );
  };

  const unmount = () => {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
  };

  const set = (enabled: boolean) => {
    if (enabled === !!root) return;
    if (!enabled) return unmount();
    changed(loadAnnotations(location.pathname));
    mount();
  };

  const clear = () => {
    saveAnnotations(location.pathname, []);
    changed([]);
    if (root) {
      unmount();
      mount();
    }
  };

  window.__tomoAgentation = { set, clear };
}

if (!window.__tomoAgentation) install();
