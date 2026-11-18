import React from "react";
import ReactDOM from "react-dom/client";
import { SessionApp } from "./SessionApp";
import { HttpHost, useMock } from "./api";
import { MockHost } from "./mock";
import "../kobra.css";
import "../theme.css";
import "../styles/collab.css";

// The joiner page is the same product as the panel: same tokens, same light/dark following the
// system. Only the VM screen itself is dark — it's a screen.
(function applyTheme() {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const set = () => {
    const theme = media.matches ? "dark" : "light";
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  };
  set();
  media.addEventListener("change", set);
})();

const host = useMock() ? new MockHost() : new HttpHost();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SessionApp host={host} />
  </React.StrictMode>,
);
