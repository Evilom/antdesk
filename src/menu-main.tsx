import React from "react";
import ReactDOM from "react-dom/client";
import FabContextMenu from "./components/FabContextMenu";
import "./menu.css";
import { applyPlatformClass } from "./lib/platform";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FabContextMenu />
  </React.StrictMode>
);
