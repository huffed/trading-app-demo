import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TradeFormValues } from "@/lib/validators/trade";

export interface ParsedRow {
  data: Record<string, string>;
  parsed: TradeFormValues | null;
  error: string | null;
  rowIndex: number;
}

export function PreviewTable({ parsedRows }: { parsedRows: ParsedRow[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Preview</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Exit</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parsedRows.slice(0, 100).map((row) => (
              <TableRow
                key={row.rowIndex}
                className={row.error ? "bg-destructive/5" : undefined}
              >
                <TableCell className="text-muted-foreground text-xs">
                  {row.rowIndex}
                </TableCell>
                {row.parsed ? (
                  <>
                    <TableCell className="font-medium">
                      {row.parsed.symbol}
                    </TableCell>
                    <TableCell>{row.parsed.side}</TableCell>
                    <TableCell className="text-right">
                      {row.parsed.quantity}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.parsed.entry_price}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.parsed.exit_price || "\u2014"}
                    </TableCell>
                    <TableCell>{row.parsed.entry_date}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {row.parsed.status}
                      </Badge>
                    </TableCell>
                  </>
                ) : (
                  <TableCell colSpan={7} className="text-xs text-destructive">
                    {row.error}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
