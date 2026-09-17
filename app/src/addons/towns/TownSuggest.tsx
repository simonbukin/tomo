import { townSchema } from "../../schemas";
import { useEffect, useState } from "react";
import { rpcParsed } from "../../api";
import { Button } from "../../components/ui";
import type { Town } from "../../generated";
import type { WorktreeNameFieldProps } from "../types";

/** The town that the next worktree gets. Its slug is the `name_hint`, so the create unlocks the town that the user saw. */
export function TownSuggest({ hidden, onHint }: WorktreeNameFieldProps) {
  const [town, setTown] = useState<Town | null>(null);
  const reroll = () => rpcParsed("town_pick", townSchema).then(setTown).catch(() => setTown(null));
  useEffect(() => {
    reroll();
  }, []);
  useEffect(() => onHint(town?.slug ?? null), [town?.slug]);
  if (hidden || !town) return null;
  return (
    <div className="town-suggest rise">
      <span className={`rarity-dot rarity-${town.rarity}`} />
      <span>{town.name}</span>
      <span className="muted">{town.ja}</span>
      <span className="faint">
        {town.pref} · {town.rarity}
      </span>
      <Button variant="link" onClick={reroll}>reroll</Button>
    </div>
  );
}
