import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Bot,
  CandlestickChart,
  Gauge,
  LayoutDashboard,
  Settings,
  TrendingUp,
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
  { href: "/chart", label: "Chart", icon: CandlestickChart },
  { href: "/performance", label: "Performance", icon: TrendingUp },
  { href: "/reports", label: "Reports", icon: Gauge },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];
