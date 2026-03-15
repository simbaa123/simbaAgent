import { Navigate, Route, Routes } from "react-router-dom";
import InboxPage from "./pages/InboxPage";
import ConsolePage from "./pages/ConsolePage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/console/:conversationId" element={<ConsolePage />} />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}

