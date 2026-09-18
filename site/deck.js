// The deck of "what if" cards beside the hero. Each card draws Tomo's chrome with the app's own
// tokens and different contents, because none of these variants exist in the app yet: the real
// components could be mounted here, but they would have nothing to render.
//
// The order shuffles on every load, and the blank card always sits at the bottom, so clicking
// through the deck ends on the question rather than on another answer.

const ROW = (name, sub, foot, dot) => `
  <div class="r">
    <span class="r-dot ${dot || ""}"></span>
    <div class="r-text">
      <div class="r-name">${name}</div>
      <div class="r-sub">${sub}</div>
      ${foot ? `<div class="r-foot">${foot}</div>` : ""}
    </div>
  </div>`;

const SIDEBAR = (label, rows) => `
  <div class="pane">
    <div class="pane-head">${label}</div>
    ${rows}
  </div>`;

const CARDS = [
  {
    id: "animals",
    caption: "i want my agents to name themselves",
    body: SIDEBAR(
      "worktrees",
      ROW("🦦 otter", "simon/costing-rewrite", "claude · 12m", "work") +
        ROW("🦫 beaver", "simon/lr-homepage", "codex · waiting", "wait") +
        ROW("🐦 crane", "simon/field-primitives", "claude · 3h", "work") +
        ROW("🦭 seal", "simon/hoist-modals", "fable · done", ""),
    ),
  },
  {
    id: "linear",
    caption: "i want my worktree state synced with linear",
    body: SIDEBAR(
      "linear · holly",
      ROW("hol-3466 fix costing", "simon/hol-3466-costing", `<span class="pill prog">in progress</span>`, "work") +
        ROW("hol-3219 create user", "simon/hol-3219-create-user", `<span class="pill rev">in review</span>`, "wait") +
        ROW("hol-2988 seed study", "simon/hol-2988-seed", `<span class="pill done">done</span>`, "") +
        ROW("hol-3501 port lootbox", "simon/hol-3501-lootbox", `<span class="pill todo">todo</span>`, ""),
    ),
  },
  {
    id: "cost",
    caption: "i want to sort my worktrees by cost",
    body: `
      <div class="pane">
        <div class="pane-head">worktrees <span class="sortby">sort: cost ↓</span></div>
        ${ROW("scenario comparisons", "simon/scenario-comparisons", `<span class="num">2.4M</span> tokens · $18.60`, "work")}
        ${ROW("labor relations ux", "simon/labor-relations-ui", `<span class="num">1.1M</span> tokens · $8.30`, "wait")}
        ${ROW("seoul", "wordloader-cogitating", `<span class="num">840k</span> tokens · $6.10`, "work")}
        ${ROW("pickerel", "simon/zany-approval", `<span class="num">96k</span> tokens · $0.72`, "")}
      </div>`,
  },
  {
    id: "rewrite",
    caption: "i want to change it all",
    body: `
      <div class="pane alt">
        <div class="alt-main">
          <div class="alt-title">costing rewrite</div>
          <div class="alt-note">three agents, one branch, since tuesday</div>
          <div class="alt-bar"><i style="width:62%"></i></div>
        </div>
        <div class="alt-side">
          <div>costing rewrite</div>
          <div class="on">homepage</div>
          <div>field primitives</div>
          <div>lootbox port</div>
        </div>
      </div>`,
  },
  {
    id: "terminals",
    caption: "i want to terminalmaxx",
    body: `
      <div class="grid9">
        ${Array.from({ length: 9 }, (_, i) => `<div class="t"><b>${["$ pnpm test", "$ cargo run", "$ claude", "$ git log", "$ vim .", "$ tail -f", "$ psql", "$ codex", "$ htop"][i]}</b><i></i><i class="s"></i></div>`).join("")}
      </div>`,
  },
  {
    id: "sound",
    caption: "i want sound effects when my agent finishes",
    body: `
      <div class="pane">
        <div class="pane-head">addons</div>
        <div class="kv"><span>sounds</span><span class="on-pill">on</span></div>
        <div class="code">[sounds]
agent_done  = "coin.wav"
needs_you   = "chime.wav"
crash       = "thud.wav"</div>
        <div class="toast">otter finished  ♪</div>
      </div>`,
  },
  {
    id: "blank",
    caption: "what's your tomo?",
    blank: true,
    body: `
      <div class="pane empty">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 65.03 Q59 88.61 86 57.58" />
          </g>
          <g fill="currentColor">
            <circle cx="23.62" cy="33.99" r="9.19" />
            <circle cx="76.38" cy="33.99" r="9.19" />
          </g>
        </svg>
      </div>`,
  },
];

const LAYOUT = [
  { x: 0, y: 0, r: -1.2, z: 6 },
  { x: 11, y: 7, r: 2.4, z: 5 },
  { x: 21, y: 13, r: -3.2, z: 4 },
  { x: 29, y: 18, r: 1.6, z: 3 },
];

export function mountDeck(root) {
  const whatIfs = CARDS.filter((c) => !c.blank);
  const blank = CARDS.find((c) => c.blank);
  for (let i = whatIfs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [whatIfs[i], whatIfs[j]] = [whatIfs[j], whatIfs[i]];
  }
  const deck = [...whatIfs, blank];

  root.innerHTML =
    deck
      .map(
        (card) => `
      <button type="button" class="card" data-id="${card.id}" aria-label="${card.caption}. Show the next one.">
        <span class="frame">
          <span class="bar"><i></i><i></i><i></i></span>
          <span class="screen">${card.body}</span>
        </span>
      </button>`,
      )
      .join("") +
    `<p class="cap" aria-live="polite"></p><p class="deck-hint">click for another</p>`;

  const cards = [...root.querySelectorAll(".card")];
  const caption = root.querySelector(".cap");
  let order = cards.map((_, i) => i);

  function place() {
    order.forEach((cardIndex, slot) => {
      const el = cards[cardIndex];
      const at = LAYOUT[Math.min(slot, LAYOUT.length - 1)];
      el.style.transform = `translate(${at.x}px, ${at.y}px) rotate(${at.r}deg)`;
      el.style.zIndex = String(at.z - Math.max(0, slot - LAYOUT.length + 1));
      el.style.opacity = slot < LAYOUT.length ? "1" : "0";
      el.toggleAttribute("data-top", slot === 0);
      el.tabIndex = slot === 0 ? 0 : -1;
    });
    caption.textContent = deck[order[0]].caption;
  }

  root.addEventListener("click", (event) => {
    if (!event.target.closest(".card")) return;
    order.push(order.shift());
    place();
  });

  place();
}
