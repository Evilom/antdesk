import React from "react";
import ReactDOM from "react-dom/client";
import NotepadPanel from "./components/NotepadPanel";
import "./notepad.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NotepadPanel />
  </React.StrictMode>
);
