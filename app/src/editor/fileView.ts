export type FileView = "text" | "image" | "video" | "audio" | "pdf";

const media = (view: FileView, extensions: string) => extensions.split(" ").map((ext) => [ext, view] as const);

/** The same extensions as `mime_of` in `src-tauri/src/viewer.rs`, which serves only these files. */
export const VIEWS: Readonly<Record<string, FileView>> = Object.fromEntries([
  ...media("image", "png jpg jpeg gif webp avif heic heif jxl svg bmp ico tif tiff"),
  ...media("video", "mp4 m4v mov webm"),
  ...media("audio", "mp3 m4a aac wav flac ogg oga opus"),
  ...media("pdf", "pdf"),
]);

const extension = (path: string): string => {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const fileView = (path: string): FileView => VIEWS[extension(path)] ?? "text";

export const isViewable = (path: string): boolean => fileView(path) !== "text";

/** A pane stores a file inside its worktree by its relative path, and a file outside it by its absolute path. */
export const absolutePath = (root: string, stored: string): string => (stored.startsWith("/") ? stored : `${root}/${stored}`);

/** The address of the `tomo-file` scheme on macOS. `version` changes when the file changes, so the view reloads. */
export const fileUrl = (path: string, version: number): string => `tomo-file://localhost/${encodeURIComponent(path)}?v=${version}`;
