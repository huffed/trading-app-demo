/**
 * Recharts `contentStyle` shared by the analytics cards; colours are the popover
 * tokens from globals.css. drawdown-card.tsx keeps its own identical copy until
 * the audit's file:line citations are released (docs/DEBT.md D-11).
 */
export const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  fontSize: 12,
  color: "var(--color-popover-foreground)",
};
