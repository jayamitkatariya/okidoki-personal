import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./kobra.css";
import "./theme.css";
import "./styles/runs.css";
import "./styles/live.css";
import "./styles/history.css";
import "./styles/memory.css";
import "./styles/skills.css";
import "./styles/settings.css";
import "./styles/vault.css";
import "./styles/shell.css";
import "./styles/dashboard.css";

// The whole window is the shell's look; its tokens and styles are scoped to this class.
document.documentElement.classList.add("shell2-on");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
