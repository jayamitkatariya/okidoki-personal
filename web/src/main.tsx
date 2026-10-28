import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./styles/runs.css";
import "./styles/live.css";
import "./styles/history.css";
import "./styles/memory.css";
import "./styles/notes.css";
import "./styles/skills.css";
import "./styles/toolbox.css";
import "./styles/settings.css";
import "./styles/vault.css";
import "./styles/dashboard.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
