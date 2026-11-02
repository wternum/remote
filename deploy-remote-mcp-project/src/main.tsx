import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./vela/drawing-toolbar.css";
import "./vela/indicator-library.css";
import "./vela/symbol-picker.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
