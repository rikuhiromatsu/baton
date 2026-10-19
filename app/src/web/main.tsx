import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// U2 が実装する。いまは土台の確認用
function App() {
  return <main />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
