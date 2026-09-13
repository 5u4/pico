import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GalleryApp } from "./gallery-app.tsx";
import { LiveApp } from "./live-app.tsx";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Pico could not find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    {window.location.pathname === "/__design" ? <GalleryApp designMode /> : <LiveApp />}
  </StrictMode>,
);
