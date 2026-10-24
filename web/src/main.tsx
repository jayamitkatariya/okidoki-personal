import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./styles/runs.css";
import "./styles/history.css";
import "./styles/memory.css";
import "./styles/skills.css";
import "./styles/toolbox.css";
import "./styles/keys.css";
import "./styles/settings.css";
import "./styles/share.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
