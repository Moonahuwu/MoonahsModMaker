import { useEffect } from "react";

/** Close a modal on Escape. Pass `enabled=false` while a busy state should
 *  block closing (the handler simply isn't attached then). */
export function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, enabled]);
}
