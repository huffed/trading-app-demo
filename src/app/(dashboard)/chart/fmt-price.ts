/**
 * Price label formatting for chart pattern annotations: 2 dp at or above 100,
 * 4 dp at or above 1, otherwise 5 dp. One copy — it was duplicated in
 * pattern-builders, pattern-scan and pattern-scan-fvg.
 */
export function fmtPrice(p: number): string {
  if (Math.abs(p) >= 100) return p.toFixed(2);
  if (Math.abs(p) >= 1) return p.toFixed(4);
  return p.toFixed(5);
}
