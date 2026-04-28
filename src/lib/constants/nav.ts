import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Bot,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Single source of truth for primary navigation. Sidebar (desktop) and
 *  MobileNav (mobile sheet) both render this list. Add/rename routes
 *  here, not in the components. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/journal", label: "Journal", icon: BookOpen },
  { href: "/algorithms", label: "Algorithms", icon: Bot },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];
