import { useEffect, useState } from "react";
import { playChime } from "../../sounds";
import {failQuietly, setUi} from "../../store";
import { setTownState, useTownState } from "./state";
import { ceremonyTier, chimeFor, prefersReducedMotion, revealDurationMs, unlockedLine } from "./model";
import type { Town } from "../../generated";

const loadTowns = () => import("./data/japan-towns.json").then((m) => m.default as Town[]);

/** The unlock moment. It never takes focus: a common town is a small corner reveal, a rare one gets a card. */
export function TownReveal() {
  const reveal = useTownState((s) => s.reveal);
  const have = useTownState((s) => s.unlocks.length);
  const [towns, setTowns] = useState<Town[] | null>(null);
  const [hiddenNonce, setHiddenNonce] = useState(0);

  useEffect(() => {
    if (reveal && !towns) loadTowns().then(setTowns).catch(failQuietly("town_list"));
  }, [reveal?.nonce]);

  const town = reveal && towns ? (towns.find((t) => t.slug === reveal.unlock.slug) ?? null) : null;
  const tier = town ? ceremonyTier(town.rarity) : null;
  const dismiss = () => setTownState({ reveal: null });

  useEffect(() => {
    if (!town || !tier) return;
    const chime = chimeFor(tier);
    if (chime) playChime(chime);
    const timer = window.setTimeout(dismiss, revealDurationMs(tier));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [reveal?.nonce, town?.slug]);

  if (!town || !tier || !towns || reveal!.nonce === hiddenNonce) return null;
  const motion = prefersReducedMotion() ? "reduced" : "full";
  const count = unlockedLine(have, towns.length);
  const viewOnMap = () => {
    setHiddenNonce(reveal!.nonce);
    setUi({ view: "towns" });
  };

  if (tier === "small") {
    return (
      <div key={reveal!.nonce} className="town-reveal town-reveal-small" role="status" data-tier={tier} data-motion={motion} onClick={viewOnMap}>
        <span className={`rarity-dot rarity-${town.rarity}`} />
        <span>
          <strong>{town.name}</strong> <span className="muted">{town.ja}</span>
        </span>
        <span className="faint">{town.pref} · unlocked {count}</span>
      </div>
    );
  }
  return (
    <div key={reveal!.nonce} className={`town-reveal town-reveal-large town-reveal-${tier}`} role="status" data-tier={tier} data-motion={motion}>
      <span className={`town-reveal-mark rarity-${town.rarity}`} aria-hidden>
        <span className="town-reveal-ring" />
        <span className="rarity-dot" />
      </span>
      <span className="town-reveal-ja">{town.ja}</span>
      <span className="town-reveal-name">
        {town.name}, {town.pref}
      </span>
      <span className={`town-reveal-rarity rarity-${town.rarity}`}>{town.rarity}</span>
      <span className="faint">unlocked {count}</span>
      <span className="town-reveal-actions">
        <button className="link" onClick={viewOnMap}>view on map</button>
        <button className="link" onClick={dismiss}>dismiss</button>
      </span>
    </div>
  );
}
