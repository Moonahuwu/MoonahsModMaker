/**
 * Items tab — scaffold.
 *
 * Planned: a grid of Deadlock shop items (pulled + icon-decoded from the game,
 * like the Heroes grid) that drills into each item's sound events so custom
 * sounds can be merged in. For now this is a placeholder we build onto.
 *
 * Likely data sources (to wire next):
 *   - scripts/abilities.vdata_c — item entities are abilities too (`m_eAbilityType`
 *     ~ item/upgrade); icons via `m_strAbilityImage`, sounds via `soundevent:"..."`.
 *   - soundevents/item_*.vsndevts (or items live under existing files) — confirm
 *     where item sound events are defined, then reuse hero_event_index-style
 *     resolution.
 */
export function ItemsTab() {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/40 p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15 text-2xl">
        🛒
      </div>
      <h3 className="text-lg font-semibold text-zinc-200">Items — coming together</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
        This tab will let you swap the sounds of Deadlock shop items, the same way
        the Heroes tab works. Scaffold in place — we'll wire the item grid and
        their sound events next.
      </p>
    </div>
  );
}
