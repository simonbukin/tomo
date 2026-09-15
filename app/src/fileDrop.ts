export interface Point {
  x: number;
  y: number;
}

export function shellEscape(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** What a drop types into a shell: escaped paths, space-separated, with a trailing space like Terminal.app. */
export function dropText(paths: readonly string[]): string {
  return paths.length ? `${paths.map(shellEscape).join(" ")} ` : "";
}

/** A drop position arrives in physical pixels; the DOM measures CSS pixels, which the webview zoom also scales. */
export function cssPoint(physical: Point, scaleFactor: number, zoom: number): Point {
  const k = (scaleFactor > 0 ? scaleFactor : 1) * (zoom > 0 ? zoom : 1);
  return { x: physical.x / k, y: physical.y / k };
}

export function containsPoint(rect: { left: number; top: number; right: number; bottom: number }, p: Point): boolean {
  return rect.right > rect.left && p.x >= rect.left && p.x < rect.right && p.y >= rect.top && p.y < rect.bottom;
}
