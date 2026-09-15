export type TermLink =
  | { kind: "url"; start: number; end: number; url: string }
  | { kind: "file"; start: number; end: number; path: string; line: number; col: number | null };

const URL_RE = /https?:\/\/[^\s"'`<>()[\]{}]+/g;
const FILE_RE = /(^|[\s"'`([{<=,])((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*):(\d+)(?::(\d+))?(?!\w)/g;

const looksLikePath = (path: string): boolean => path.includes("/") || /\.[A-Za-z]\w*$/.test(path);

/** URLs and `path:line[:col]` spans in one line of terminal text. Offsets are string indexes, end exclusive. */
export function findLinks(text: string): TermLink[] {
  const urls: TermLink[] = [...text.matchAll(URL_RE)].map((m) => {
    const url = m[0].replace(/[.,;:!?'"]+$/, "");
    const start = m.index ?? 0;
    return { kind: "url", start, end: start + url.length, url };
  });
  const insideUrl = (i: number) => urls.some((u) => i >= u.start && i < u.end);
  const files: TermLink[] = [...text.matchAll(FILE_RE)]
    .map((m) => ({ start: (m.index ?? 0) + m[1].length, end: (m.index ?? 0) + m[0].length, path: m[2], line: Number(m[3]), col: m[4] ? Number(m[4]) : null }))
    .filter((f) => f.line > 0 && looksLikePath(f.path) && !insideUrl(f.start))
    .map((f) => ({ kind: "file", ...f }));
  return [...urls, ...files].sort((a, b) => a.start - b.start);
}

/** An absolute, normalized path for a link. Relative paths resolve against `cwd`; `~/` needs `home`. */
export function resolvePath(path: string, cwd: string, home: string | null): string | null {
  const tilde = path.startsWith("~/");
  const base = path.startsWith("/") ? "" : tilde ? home : cwd;
  if (base == null) return null;
  const parts = `${base}/${tilde ? path.slice(2) : path}`
    .split("/")
    .reduce<string[]>((out, part) => (part === "" || part === "." ? out : part === ".." ? out.slice(0, -1) : [...out, part]), []);
  return `/${parts.join("/")}`;
}
