import { Suspense } from "react";
import ChatCenter from "@/components/chat/ChatCenter";
export default function ChatPage() {
  return (
    <Suspense fallback={<p>Opening conversations…</p>}>
      <ChatCenter />
    </Suspense>
  );
}
