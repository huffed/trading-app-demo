"use client";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { MobileNav } from "@/components/layout/mobile-nav";

export function Topbar() {
  return (
    <header className="flex h-14 items-center border-b border-border bg-background px-4 gap-4">
      <MobileNav />
      <div className="flex-1" />
      <ThemeToggle />
      <UserMenu />
    </header>
  );
}
