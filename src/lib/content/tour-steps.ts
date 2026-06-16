export interface TourStep {
  id: string;
  title: string;
  description: string;
  icon: string;
  target?: string;
}

export const tourSteps: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to QuantTrader",
    description:
      "Let's walk you through the key features. We'll highlight each one so you know exactly where to find it.",
    icon: "👋",
  },
  {
    id: "dashboard",
    title: "Your Dashboard",
    description:
      "This is your home base. Stats update automatically as you log trades — your P&L, win rate, and open positions are all here.",
    icon: "📊",
    target: "[data-tour='dashboard']",
  },
  {
    id: "trades",
    title: "Trade Management",
    description:
      "Log trades manually or import a CSV. The app calculates P&L, tracks your history, and lets you filter by status, side, or asset class.",
    icon: "📈",
    target: "[data-tour='trades']",
  },
  {
    id: "journal",
    title: "Trading Journal",
    description:
      "Reflect on your decisions and emotions after each trade. Our AI reads your entries and gives you coaching feedback automatically.",
    icon: "📝",
    target: "[data-tour='journal']",
  },
  {
    id: "done",
    title: "You're All Set!",
    description:
      "Start by adding your first trade, then write a journal entry about it. The more data you add, the smarter your AI coach becomes.",
    icon: "🚀",
  },
];
