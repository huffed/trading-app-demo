/**
 * Portfolio = the prop-firm account container. Multiple algorithms link to
 * one portfolio and share its capital + prop-firm risk rules. Daily-loss
 * halt and drawdown checks fire at portfolio level so a losing day on
 * one algo flattens the others before FTMO closes the account.
 */
import type { PropFirmRules } from "./algorithm";

export interface Portfolio {
  id: string;
  user_id: string;
  name: string;
  broker_connection_id: string | null;
  capital: number;
  /** Same shape as AlgorithmRules.prop_firm — DLL, max_drawdown, etc. */
  prop_firm_rules: Partial<PropFirmRules>;
  created_at: string;
  updated_at: string;
}

export interface CreatePortfolioInput {
  name: string;
  capital: number;
  broker_connection_id?: string | null;
  prop_firm_rules?: Partial<PropFirmRules>;
}
