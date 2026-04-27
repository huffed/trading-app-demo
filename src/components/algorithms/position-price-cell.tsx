import { formatBrokerDivergence, formatPriceValue } from "@/lib/utils/pnl";

/**
 * Render a price cell with an optional broker-fill sublabel underneath
 * showing the actual broker price + the divergence in pips/%. Only renders
 * the sublabel when a broker price is recorded AND it differs from ours.
 */
export function PriceCellWithBroker({
  symbol,
  paperPrice,
  brokerPrice,
}: {
  symbol: string;
  paperPrice: number | null;
  brokerPrice: number | null | undefined;
}) {
  const divergence = formatBrokerDivergence(symbol, paperPrice, brokerPrice ?? null);
  return (
    <div className="flex flex-col items-end">
      <span>{formatPriceValue(symbol, paperPrice)}</span>
      {brokerPrice != null && divergence && (
        <span className="text-[10px] text-muted-foreground">
          broker {formatPriceValue(symbol, brokerPrice)} ({divergence})
        </span>
      )}
    </div>
  );
}
