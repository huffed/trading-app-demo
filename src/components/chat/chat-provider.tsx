"use client";

import { useState } from "react";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { ChatButton } from "./chat-button";
import { ChatDrawer } from "./chat-drawer";

export function ChatProvider() {
  const [open, setOpen] = useState(false);
  const { data } = useDashboardStats();
  const setChatSeen = useOnboardingStore((s) => s.setChatSeen);

  function handleOpen() {
    setOpen(true);
    setChatSeen();
  }

  return (
    <>
      <ChatButton onClick={handleOpen} />
      <ChatDrawer
        open={open}
        onOpenChange={setOpen}
        stats={data?.stats ?? null}
      />
    </>
  );
}
