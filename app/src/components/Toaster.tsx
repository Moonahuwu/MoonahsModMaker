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
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}

const ToastCtx = createContext<{ push: (kind: Kind, text: string) => void }>({
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

  const push = useCallback((kind: Kind, text: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, text }]);
    const ttl = kind === "error" ? 6000 : 3000;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);

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
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
