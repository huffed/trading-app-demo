"use client";

import { useEffect } from "react";
import { getExchangeRate } from "@/app/(dashboard)/settings/actions";
import { setActiveCurrency } from "@/lib/utils/pnl";

export function CurrencyInitializer({ currency }: { currency: string }) {
  useEffect(() => {
    if (currency === "USD") {
      setActiveCurrency("USD", 1);
      return;
    }

    // Set currency immediately with rate=1 so the symbol updates,
    // then fetch the real rate in the background
    setActiveCurrency(currency, 1);
    getExchangeRate(currency).then((result) => {
      if (result.success) {
        setActiveCurrency(currency, result.data);
      }
    });
  }, [currency]);

  return null;
}
