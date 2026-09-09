import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GalleryApp } from "./gallery-app.tsx";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Pico could not find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <GalleryApp designMode={window.location.pathname === "/__design"} />
  </StrictMode>,
);
