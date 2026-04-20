"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ArrowLeftRight,
  BookOpen,
  Bot,
  BarChart3,
  Settings,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/ui-store";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/journal", label: "Journal", icon: BookOpen },
  { href: "/algorithms", label: "Algorithms", icon: Bot },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

function SidebarHeader({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  if (open) {
    return (
      <>
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary shrink-0">
            <span className="text-xs font-bold text-primary-foreground">Q</span>
          </div>
          <span className="font-semibold text-sm">QuantTrader</span>
        </Link>
        <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto" onClick={onToggle}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </>
    );
  }

  return (
    <button
      onClick={onToggle}
      className="mx-auto flex h-7 w-7 items-center justify-center rounded-md bg-primary cursor-pointer"
    >
      <span className="text-xs font-bold text-primary-foreground">Q</span>
    </button>
  );
}

function NavItem({
  item,
  isActive,
  isLoading,
  sidebarOpen,
  onClick,
}: {
  item: (typeof navItems)[number];
  isActive: boolean;
  isLoading: boolean;
  sidebarOpen: boolean;
  onClick: () => void;
}) {
  const link = (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors overflow-hidden",
        isActive
          ? "bg-sidebar-accent text-sidebar-primary"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
      )}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {sidebarOpen && <span>{item.label}</span>}
      {isLoading && (
        <span className="absolute bottom-0 left-0 h-0.5 w-full animate-pulse bg-primary" />
      )}
    </Link>
  );

  if (!sidebarOpen) {
    return (
      <Tooltip>
        <TooltipTrigger render={link} />
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen, toggleSidebar } = useUIStore();
  const [loadingHref, setLoadingHref] = useState<string | null>(null);

  // Derive: if we navigated to the loading target, clear it
  const isStillLoading =
    loadingHref !== null && !pathname.startsWith(loadingHref);

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col border-r border-border bg-sidebar transition-all duration-200",
        sidebarOpen ? "w-60" : "w-16"
      )}
    >
      <div className="flex h-14 items-center border-b border-border px-4">
        <SidebarHeader open={sidebarOpen} onToggle={toggleSidebar} />
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));

          return (
            <NavItem
              key={item.href}
              item={item}
              isActive={isActive}
              isLoading={isStillLoading && loadingHref === item.href}
              sidebarOpen={sidebarOpen}
              onClick={() => {
                if (!isActive) {
                  setLoadingHref(item.href);
                }
              }}
            />
          );
        })}
      </nav>
    </aside>
  );
}
