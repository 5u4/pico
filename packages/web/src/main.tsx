import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Pico could not find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
