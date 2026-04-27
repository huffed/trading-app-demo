import { z } from "zod";

export const assetClasses = ["equity", "option", "future", "forex", "crypto", "commodity"] as const;

export const tradeSides = ["long", "short"] as const;
export const tradeStatuses = ["open", "closed"] as const;

export const tradeFormSchema = z
  .object({
    symbol: z
      .string()
      .min(1, "Symbol is required")
      .max(20)
      .transform((v) => v.toUpperCase().trim()),
    asset_class: z.enum(assetClasses),
    side: z.enum(tradeSides),
    quantity: z.coerce.number().positive("Quantity must be positive"),
    entry_price: z.coerce.number().min(0, "Entry price must be non-negative"),
    exit_price: z.coerce
      .number()
      .min(0, "Exit price must be non-negative")
      .optional()
      .or(z.literal("")),
    entry_date: z.string().min(1, "Entry date is required"),
    exit_date: z.string().optional().or(z.literal("")),
    commission: z.coerce.number().min(0).default(0),
    fees: z.coerce.number().min(0).default(0),
    strategy: z.string().max(100).optional().or(z.literal("")),
    tags: z.array(z.string()).default([]),
    notes: z.string().max(2000).optional().or(z.literal("")),
    status: z.enum(tradeStatuses),
    currency: z.string().default("USD"),
  })
  .refine(
    (data) => {
      if (data.status === "closed") {
        return (
          data.exit_price !== undefined &&
          data.exit_price !== "" &&
          data.exit_date !== undefined &&
          data.exit_date !== ""
        );
      }
      return true;
    },
    {
      message: "Closed trades require exit price and exit date",
      path: ["exit_price"],
    }
  );

export type TradeFormValues = z.infer<typeof tradeFormSchema>;

export const csvRowSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(tradeSides),
  quantity: z.coerce.number().positive(),
  entry_price: z.coerce.number().min(0),
  exit_price: z.coerce.number().min(0).optional(),
  entry_date: z.string().min(1),
  exit_date: z.string().optional(),
  commission: z.coerce.number().min(0).optional().default(0),
  fees: z.coerce.number().min(0).optional().default(0),
  strategy: z.string().optional(),
  notes: z.string().optional(),
  asset_class: z.enum(assetClasses).optional().default("equity"),
});

export type CsvRowValues = z.infer<typeof csvRowSchema>;
