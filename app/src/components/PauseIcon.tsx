/** A crisp two-bar pause glyph — the "▮▮" text glyph renders stretched and
 *  inconsistently across fonts, so draw the bars with CSS instead. */
export function PauseIcon() {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      <span className="h-2.5 w-[3px] rounded-[1px] bg-current" />
      <span className="h-2.5 w-[3px] rounded-[1px] bg-current" />
    </span>
  );
}
