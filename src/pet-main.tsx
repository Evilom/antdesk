import React from "react";
import ReactDOM from "react-dom/client";
import Pet from "./pet";
import "./pet.css";
import { applyPlatformClass } from "./lib/platform";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Pet />
  </React.StrictMode>
);
