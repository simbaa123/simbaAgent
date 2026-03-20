import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./ui/App";
import "./main.css";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
