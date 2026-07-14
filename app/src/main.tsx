import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import { ModMenuOverlay } from "./components/ModMenuOverlay";
import { ToastProvider } from "./components/Toaster";

// The same bundle serves two windows: the main app and the F8 mod-menu overlay
// (loaded as index.html#overlay). The overlay window is transparent, so strip
// any page background there and render just the floating panel.
const isOverlay = window.location.hash === "#overlay";

if (isOverlay) {
  for (const el of [document.documentElement, document.body]) {
    el.style.background = "transparent";
  }
  const root = document.getElementById("root");
  if (root) root.style.background = "transparent";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isOverlay ? (
      <ModMenuOverlay />
    ) : (
      // reducedMotion="user": every motion/react animation collapses to a
      // simple crossfade when Windows' "show animations" is off.
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <App />
        </ToastProvider>
      </MotionConfig>
    )}
  </React.StrictMode>,
);
