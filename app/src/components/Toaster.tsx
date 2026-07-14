import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Kind = "info" | "success" | "error";
/** Optional inline action (e.g. "Undo" after a destructive change). */
interface ToastAction {
  label: string;
  onClick: () => void;
}
interface Toast {
  id: number;
  kind: Kind;
  text: string;
  action?: ToastAction;
}

const ToastCtx = createContext<{
  push: (kind: Kind, text: string, action?: ToastAction) => void;
}>({
  push: () => {},
});

export const useToast = () => useContext(ToastCtx);

const STYLES: Record<Kind, string> = {
  info: "border-zinc-700 bg-zinc-900/90 text-zinc-200",
  success: "border-emerald-600/50 bg-emerald-950/80 text-emerald-200",
  error: "border-red-700/60 bg-red-950/80 text-red-200",
};

const ICON: Record<Kind, string> = { info: "›", success: "✓", error: "✗" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: Kind, text: string, action?: ToastAction) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, text, action }]);
    // Action toasts linger long enough to actually click the button.
    const ttl = kind === "error" || action ? 6000 : 3000;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-24 right-5 z-50 flex w-80 flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-xl backdrop-blur ${STYLES[t.kind]}`}
            >
              <span className="mt-0.5 font-bold opacity-80">{ICON[t.kind]}</span>
              <span className="leading-snug">{t.text}</span>
              {t.action && (
                <button
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                  className="ml-auto shrink-0 self-center rounded border border-current/40 px-2 py-0.5 text-xs font-semibold opacity-90 transition hover:opacity-100"
                >
                  {t.action.label}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
