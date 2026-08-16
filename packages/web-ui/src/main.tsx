import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ChatApp from "./ChatApp.tsx";
import "./product.css";

const root = document.getElementById("root");
if (root === null) throw new Error("PiCloud root element is missing");

createRoot(root).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>,
);
