import React from "react";
import ReactDOM from "react-dom/client";
import { SessionApp } from "./SessionApp";
import { HttpHost, useMock } from "./api";
import { MockHost } from "./mock";
import "../kobra.css";
import "../theme.css";
import "../styles/collab.css";

// The session page is its own dark, glassy surface — a window onto someone else's Mac.
document.documentElement.dataset.theme = "dark";
document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

const host = useMock() ? new MockHost() : new HttpHost();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SessionApp host={host} />
  </React.StrictMode>,
);
