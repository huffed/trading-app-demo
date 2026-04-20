export interface TourStep {
  id: string;
  title: string;
  description: string;
  icon: string;
}

export const tourSteps: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to QuantTrader",
    description:
      "Let's take a quick tour of your trading platform. We'll show you the key features that help you trade smarter — even if you're just getting started.",
    icon: "👋",
  },
  {
    id: "dashboard",
    title: "Your Dashboard",
    description:
      "This is your home base. You'll see your total profit/loss, win rate, open positions, and charts that track your performance over time. Everything updates as you add trades.",
    icon: "📊",
  },
  {
    id: "trades",
    title: "Trade Management",
    description:
      "Log every trade you make — the asset, entry and exit prices, fees, and strategy. You can enter them manually or import a CSV file from your broker. The app calculates your P&L automatically.",
    icon: "📈",
  },
  {
    id: "journal",
    title: "Trading Journal",
    description:
      "The journal is where you reflect on your decisions and emotions. After each trade, write about what you were thinking and feeling. Our AI will analyze your entries and help you spot patterns.",
    icon: "📝",
  },
  {
    id: "ai",
    title: "AI-Powered Analysis",
    description:
      "When you save a journal entry, our AI automatically reviews it and gives you feedback — what went well, what to improve, and tips for next time. It's like having a trading coach in your pocket.",
    icon: "✨",
  },
  {
    id: "done",
    title: "You're All Set!",
    description:
      "Start by adding your first trade, then write a journal entry about it. The more data you add, the better our AI can help you improve. You can dismiss the info icons on the dashboard anytime.",
    icon: "🚀",
  },
];
