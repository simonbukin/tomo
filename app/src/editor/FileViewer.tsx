import { FileText, Film, Image, Music, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { onFrame } from "../api";
import type { Id } from "../types";
import { fileUrl, type FileView } from "./fileView";

export const VIEW_ICONS: Record<FileView, LucideIcon> = { text: FileText, image: Image, video: Film, audio: Music, pdf: FileText };

function useFileVersion(worktreeId: Id, stored: string): number {
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      onFrame((f) => {
        if (f.event !== "file_changed") return;
        const { worktree_id, path } = f.data as { worktree_id: Id; path: string };
        if (worktree_id === worktreeId && path === stored) setVersion((v) => v + 1);
      }),
    [worktreeId, stored],
  );
  return version;
}

function ImageView({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const [actual, setActual] = useState(false);
  const [size, setSize] = useState<string | null>(null);
  return (
    <div className={`viewer viewer-image${actual ? " viewer-actual" : ""}`} onClick={() => setActual((a) => !a)} title={actual ? "Fit to the pane" : "Show at actual size"}>
      <img src={src} alt={name} draggable={false} onError={onError} onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      {size && <span className="viewer-size">{size}</span>}
    </div>
  );
}

/** Shows an image, a video, an audio file, or a PDF that the webview reads through the `tomo-file` scheme. */
export function FileViewer({ view, worktreeId, stored, path }: { view: Exclude<FileView, "text">; worktreeId: Id; stored: string; path: string }) {
  const version = useFileVersion(worktreeId, stored);
  const [failed, setFailed] = useState(false);
  const src = fileUrl(path, version);
  const name = path.split("/").pop() ?? path;
  useEffect(() => setFailed(false), [src]);
  if (failed)
    return (
      <div className="editor-error" role="alert">
        <p>Tomo cannot show {name}. The file is gone, or macOS cannot play its format.</p>
      </div>
    );
  const fail = () => setFailed(true);
  if (view === "image") return <ImageView src={src} name={name} onError={fail} />;
  if (view === "video") return <div className="viewer"><video key={src} src={src} controls preload="metadata" onError={fail} /></div>;
  if (view === "audio") return <div className="viewer"><audio key={src} src={src} controls preload="metadata" onError={fail} /></div>;
  return <iframe className="viewer-pdf" key={src} src={src} title={name} />;
}

