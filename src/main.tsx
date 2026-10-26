import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ConfirmHost } from "./confirm";
import { FixDialogHost } from "./FixDialog";
import { ArtPickerHost } from "./ArtPicker";
import { Hosts } from "./ui";
import "@fontsource-variable/inter";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ConfirmHost />
    <FixDialogHost />
    <ArtPickerHost />
    <Hosts />
  </React.StrictMode>,
);
