import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { applyPlatformClass } from "./lib/platform";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
