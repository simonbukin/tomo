import type { Annotation } from "agentation";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const optional = (label: string, value: string | undefined, quote = false) => {
  const text = value ? oneLine(value) : "";
  return text ? [`   ${label}: ${quote ? `"${text}"` : text}`] : [];
};

const item = (a: Annotation, i: number) =>
  [
    `${i + 1}. ${oneLine(a.element)} \`${a.elementPath}\``,
    `   ${oneLine(a.comment)}`,
    ...optional("selected", a.selectedText, true),
    ...optional("nearby", a.nearbyText, true),
    ...optional("react", a.reactComponents),
    ...optional("source", a.sourceFile),
  ].join("\n");

export function feedbackMarkdown(url: string, title: string, annotations: Annotation[]): string {
  const name = oneLine(title);
  const heading = name ? `## ${name} (${url})` : `## ${url}`;
  return [heading, "", ...annotations.map(item)].join("\n");
}
