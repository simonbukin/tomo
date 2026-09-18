// Static audit of the render states: what each touches, and where two could collide.
// Splits the DEMANDS array by brace depth rather than by regex, so nested functions stay put.
import { readFileSync } from "node:fs";

const src = readFileSync("/Users/simonbukin/Projects/tomo/site/index.html", "utf8");
const styles = src.slice(0, src.indexOf("</style>"));
const from = src.indexOf("var DEMANDS = [");
const body = src.slice(from + "var DEMANDS = [".length);

const states = [];
let depth = 0;
let start = -1;
for (let i = 0; i < body.length; i++) {
  const ch = body[i];
  if (ch === "{") {
    if (depth === 0) start = i;
    depth++;
  } else if (ch === "}") {
    depth--;
    if (depth === 0 && start >= 0) {
      states.push(body.slice(start, i + 1));
      start = -1;
    }
  } else if (ch === "]" && depth === 0) break;
}

const parsed = states.map((text) => ({
  id: (text.match(/id: "(\w+)"/) || [])[1],
  css: (text.match(/css: "(\w+)"/) || [])[1] || null,
  kinds: ["knows", "draws", "adds"].filter((k) => new RegExp(`\\b${k}: function`).test(text)),
  creates: [...new Set([...text.matchAll(/overlay\("([\w-]+)"\)|className = "([\w-]+)"/g)].map((m) => m[1] || m[2]))],
  readsPalette: /getComputedStyle\(app\)/.test(text),
}));

const groups = Object.fromEntries(
  [...src.matchAll(/(\w+): "(palette|side|main)"/g)].map((m) => [m[1], m[2]]),
);

console.log(`states: ${parsed.length}\n`);
console.log("id".padEnd(9), "class".padEnd(8), "kind".padEnd(13), "creates".padEnd(9), "group".padEnd(8), "palette");
for (const s of parsed) {
  console.log(
    String(s.id).padEnd(9),
    (s.css || "-").padEnd(8),
    (s.kinds.join("+") || "class-only").padEnd(13),
    (s.creates.join(",") || "-").padEnd(9),
    (groups[s.id] || "-").padEnd(8),
    s.creates.some((c) => ["tank", "cash", "rain"].includes(c)) && !s.readsPalette ? "NO" : "-",
  );
}

const problems = [];
const cleared = (src.match(/app\.querySelectorAll\("([^"]+)"\)\)\.forEach/) || [])[1] || "";
for (const s of parsed) {
  for (const made of s.creates) {
    if (!cleared.split(",").map((x) => x.trim()).includes("." + made)) {
      problems.push(`${s.id} creates .${made}; reset clears "${cleared}"`);
    }
  }
}
const byGroup = {};
for (const s of parsed) if (groups[s.id]) (byGroup[groups[s.id]] ||= []).push(s.id);
for (const [g, ids] of Object.entries(byGroup)) {
  if (ids.length < 2) problems.push(`group "${g}" holds only ${ids.join()}, so it excludes nothing`);
}
for (const sel of [".clip", ".overlay"]) {
  const rule = (styles.match(new RegExp(`\\${sel} \\{[^}]*\\}`)) || [""])[0];
  if (/bottom: \d/.test(rule)) problems.push(`${sel} pins a numeric bottom; the vim status line sits there`);
}
const limit = (src.match(/var LIMIT = (\d+)/) || [])[1];
if (!limit) problems.push("no stack limit");

console.log("\ngroups:", JSON.stringify(byGroup));
console.log("stack limit:", limit);
console.log("\n" + (problems.length ? "PROBLEMS\n  " + problems.join("\n  ") : "no problems found"));
