import React from "react";
import ReactDOM from "react-dom/client";
import FAB from "./fab";
import "./fab.css";
import { applyPlatformClass } from "./lib/platform";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FAB />
  </React.StrictMode>
);
