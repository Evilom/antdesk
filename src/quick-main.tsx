import React from "react";
import ReactDOM from "react-dom/client";
import QuickPanel from "./components/QuickPanel";
import "./quick.css";
import { applyPlatformClass } from "./lib/platform";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QuickPanel />
  </React.StrictMode>
);
