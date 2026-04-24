"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PropFirmReport } from "@/lib/market-data/types";

function RuleStatus({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {passed
        ? <CheckCircle2 className="h-3 w-3 text-[var(--profit)] shrink-0" />
        : <XCircle className="h-3 w-3 text-[var(--loss)] shrink-0" />}
      <span className={passed ? "text-muted-foreground" : ""}>{label}</span>
    </div>
  );
}

export function PropFirmReportCard({ report }: { report: PropFirmReport }) {
  const passed = report.evaluation_result === "pass";

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Prop Firm Compliance</span>
        <Badge className={passed ? "bg-[var(--profit)]/10 text-[var(--profit)]" : "bg-[var(--loss)]/10 text-[var(--loss)]"}>
          {passed ? "PASS" : "FAIL"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <RuleStatus label={`Daily loss: ${report.max_daily_loss}% max (${report.daily_loss_breaches} breaches)`} passed={report.daily_loss_breaches === 0} />
        <RuleStatus label={`Drawdown: ${report.peak_drawdown}%`} passed={!report.drawdown_breached} />
        <RuleStatus label={`Consecutive losses: ${report.max_consecutive_losses}`} passed={!report.kill_switch_triggered} />
        <RuleStatus label={`Consistency: ${report.worst_day_pct_of_profit.toFixed(0)}% max day`} passed={report.consistency_pass} />
        <RuleStatus label="Profit target" passed={report.profit_target_met} />
      </div>

      {(report.total_slippage > 0 || report.total_commission > 0) && (
        <div className="flex gap-4 text-xs text-muted-foreground">
          {report.total_slippage > 0 && <span>Slippage: ${report.total_slippage.toFixed(2)}</span>}
          {report.total_commission > 0 && <span>Commission: ${report.total_commission.toFixed(2)}</span>}
        </div>
      )}

      {report.fail_reasons.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-[var(--loss)]">Fail reasons</p>
          {report.fail_reasons.map((r, i) => (
            <p key={i} className="text-xs text-muted-foreground">- {r}</p>
          ))}
        </div>
      )}
    </div>
  );
}
