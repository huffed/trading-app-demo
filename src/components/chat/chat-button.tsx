"use client";

import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";

interface ChatButtonProps {
  onClick: () => void;
}

export function ChatButton({ onClick }: ChatButtonProps) {
  const chatSeen = useOnboardingStore((s) => s.chatSeen);

  return (
    <Button
      size="icon-lg"
      data-tour="chat"
      className="fixed bottom-6 right-6 z-40 rounded-full shadow-lg"
      onClick={onClick}
    >
      <MessageCircle className="h-5 w-5" />
      {!chatSeen && (
        <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-[var(--profit)] animate-pulse" />
      )}
    </Button>
  );
}
