/**
 * Supabase database types — GENERATED from the live schema 2026-06-17
 * via the Supabase MCP (`generate_typescript_types`). Do not hand-edit;
 * regenerate after applying migrations. Single source of truth for row
 * shapes — local `interface XRow { ... }` duplicates and
 * `data as unknown as X` casts should derive from `Tables<"name">`
 * instead (audit 2026-06-11: ~18 files hand-cast rows).
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          algorithm_id: string | null
          created_at: string | null
          details: Json | null
          event_type: string
          id: string
          position_id: string | null
          ticker: string | null
          user_id: string
        }
        Insert: {
          algorithm_id?: string | null
          created_at?: string | null
          details?: Json | null
          event_type: string
          id?: string
          position_id?: string | null
          ticker?: string | null
          user_id: string
        }
        Update: {
          algorithm_id?: string | null
          created_at?: string | null
          details?: Json | null
          event_type?: string
          id?: string
          position_id?: string | null
          ticker?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "paper_positions"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log_archive: {
        Row: {
          algorithm_id: string | null
          archive_id: string
          archived_at: string
          created_at: string | null
          details: Json | null
          event_type: string
          id: string
          position_id: string | null
          ticker: string | null
          user_id: string
        }
        Insert: {
          algorithm_id?: string | null
          archive_id?: string
          archived_at?: string
          created_at?: string | null
          details?: Json | null
          event_type: string
          id?: string
          position_id?: string | null
          ticker?: string | null
          user_id: string
        }
        Update: {
          algorithm_id?: string | null
          archive_id?: string
          archived_at?: string
          created_at?: string | null
          details?: Json | null
          event_type?: string
          id?: string
          position_id?: string | null
          ticker?: string | null
          user_id?: string
        }
        Relationships: []
      }
      algorithm_geometry_sweeps: {
        Row: {
          algorithm_id: string
          cells: Json
          created_at: string
          id: string
          ran_at: string
          user_id: string
        }
        Insert: {
          algorithm_id: string
          cells?: Json
          created_at?: string
          id?: string
          ran_at?: string
          user_id: string
        }
        Update: {
          algorithm_id?: string
          cells?: Json
          created_at?: string
          id?: string
          ran_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "algorithm_geometry_sweeps_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
        ]
      }
      algorithm_rule_changes: {
        Row: {
          after: Json
          algorithm_id: string
          before: Json
          changed_at: string
          fields_changed: string[]
          id: string
          source: string
          user_id: string
        }
        Insert: {
          after?: Json
          algorithm_id: string
          before?: Json
          changed_at?: string
          fields_changed?: string[]
          id?: string
          source: string
          user_id: string
        }
        Update: {
          after?: Json
          algorithm_id?: string
          before?: Json
          changed_at?: string
          fields_changed?: string[]
          id?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "algorithm_rule_changes_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
        ]
      }
      algorithm_watchlist: {
        Row: {
          added_by: string
          algorithm_id: string
          auto_paused: boolean
          auto_paused_at: string | null
          auto_paused_reason: string | null
          backtest_metrics: Json | null
          created_at: string
          id: string
          name: string
          notes: string | null
          ticker: string
          updated_at: string
          user_id: string
        }
        Insert: {
          added_by?: string
          algorithm_id: string
          auto_paused?: boolean
          auto_paused_at?: string | null
          auto_paused_reason?: string | null
          backtest_metrics?: Json | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          ticker: string
          updated_at?: string
          user_id: string
        }
        Update: {
          added_by?: string
          algorithm_id?: string
          auto_paused?: boolean
          auto_paused_at?: string | null
          auto_paused_reason?: string | null
          backtest_metrics?: Json | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          ticker?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "algorithm_watchlist_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
        ]
      }
      algorithms: {
        Row: {
          ai_analysis: string | null
          asset_class: string
          backtest_results: Json | null
          broker_connection_id: string | null
          capital: number
          created_at: string | null
          description: string
          id: string
          last_scanned_at: string | null
          leverage: number
          live_trading_enabled: boolean
          llm_walk_forward_cache: Json | null
          metrics_reset_at: string | null
          name: string
          portfolio_id: string | null
          risk_level: string
          rules: Json
          status: string
          strategy_id: string | null
          time_horizon: string
          updated_at: string | null
          user_hints: string | null
          user_id: string
        }
        Insert: {
          ai_analysis?: string | null
          asset_class?: string
          backtest_results?: Json | null
          broker_connection_id?: string | null
          capital?: number
          created_at?: string | null
          description?: string
          id?: string
          last_scanned_at?: string | null
          leverage?: number
          live_trading_enabled?: boolean
          llm_walk_forward_cache?: Json | null
          metrics_reset_at?: string | null
          name: string
          portfolio_id?: string | null
          risk_level?: string
          rules?: Json
          status?: string
          strategy_id?: string | null
          time_horizon?: string
          updated_at?: string | null
          user_hints?: string | null
          user_id: string
        }
        Update: {
          ai_analysis?: string | null
          asset_class?: string
          backtest_results?: Json | null
          broker_connection_id?: string | null
          capital?: number
          created_at?: string | null
          description?: string
          id?: string
          last_scanned_at?: string | null
          leverage?: number
          live_trading_enabled?: boolean
          llm_walk_forward_cache?: Json | null
          metrics_reset_at?: string | null
          name?: string
          portfolio_id?: string | null
          risk_level?: string
          rules?: Json
          status?: string
          strategy_id?: string | null
          time_horizon?: string
          updated_at?: string | null
          user_hints?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "algorithms_broker_connection_id_fkey"
            columns: ["broker_connection_id"]
            isOneToOne: false
            referencedRelation: "broker_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "algorithms_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "algorithms_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      backtest_trades: {
        Row: {
          algorithm_id: string
          created_at: string
          entry_date: string
          entry_price: number
          exit_date: string
          exit_price: number
          exit_reason: string | null
          id: string
          pnl: number
          r_multiple: number | null
          run_at: string
          side: string
          ticker: string
          user_id: string
        }
        Insert: {
          algorithm_id: string
          created_at?: string
          entry_date: string
          entry_price: number
          exit_date: string
          exit_price: number
          exit_reason?: string | null
          id?: string
          pnl: number
          r_multiple?: number | null
          run_at?: string
          side: string
          ticker: string
          user_id: string
        }
        Update: {
          algorithm_id?: string
          created_at?: string
          entry_date?: string
          entry_price?: number
          exit_date?: string
          exit_price?: number
          exit_reason?: string | null
          id?: string
          pnl?: number
          r_multiple?: number | null
          run_at?: string
          side?: string
          ticker?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtest_trades_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_connections: {
        Row: {
          account_id: string
          account_login: string | null
          account_snapshot: Json | null
          api_token: string
          broker_name: string | null
          created_at: string | null
          id: string
          label: string
          last_error: string | null
          last_synced_at: string | null
          provider: string
          refresh_token: string | null
          region: string
          server: string | null
          status: string
          token_expires_at: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          account_id: string
          account_login?: string | null
          account_snapshot?: Json | null
          api_token: string
          broker_name?: string | null
          created_at?: string | null
          id?: string
          label: string
          last_error?: string | null
          last_synced_at?: string | null
          provider?: string
          refresh_token?: string | null
          region?: string
          server?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          account_id?: string
          account_login?: string | null
          account_snapshot?: Json | null
          api_token?: string
          broker_name?: string | null
          created_at?: string | null
          id?: string
          label?: string
          last_error?: string | null
          last_synced_at?: string | null
          provider?: string
          refresh_token?: string | null
          region?: string
          server?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      journal_entries: {
        Row: {
          ai_analysis: string | null
          ai_analyzed_at: string | null
          content: string
          created_at: string | null
          emotion: string
          entry_type: string
          id: string
          linked_trade_ids: string[] | null
          self_rating: number | null
          tags: string[] | null
          title: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          ai_analysis?: string | null
          ai_analyzed_at?: string | null
          content?: string
          created_at?: string | null
          emotion?: string
          entry_type?: string
          id?: string
          linked_trade_ids?: string[] | null
          self_rating?: number | null
          tags?: string[] | null
          title: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          ai_analysis?: string | null
          ai_analyzed_at?: string | null
          content?: string
          created_at?: string | null
          emotion?: string
          entry_type?: string
          id?: string
          linked_trade_ids?: string[] | null
          self_rating?: number | null
          tags?: string[] | null
          title?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      llm_decisions: {
        Row: {
          algorithm_id: string
          bar_date: string
          confidence: number | null
          context: Json | null
          created_at: string
          decision: string
          had_position: string
          id: string
          model: string
          paper_position_id: string | null
          prompt_version: string
          provider: string
          reasoning: string | null
          regime: string
          source: string
          trade_outcome: Json | null
          user_id: string
        }
        Insert: {
          algorithm_id: string
          bar_date: string
          confidence?: number | null
          context?: Json | null
          created_at?: string
          decision: string
          had_position: string
          id?: string
          model: string
          paper_position_id?: string | null
          prompt_version: string
          provider: string
          reasoning?: string | null
          regime: string
          source: string
          trade_outcome?: Json | null
          user_id: string
        }
        Update: {
          algorithm_id?: string
          bar_date?: string
          confidence?: number | null
          context?: Json | null
          created_at?: string
          decision?: string
          had_position?: string
          id?: string
          model?: string
          paper_position_id?: string | null
          prompt_version?: string
          provider?: string
          reasoning?: string | null
          regime?: string
          source?: string
          trade_outcome?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_decisions_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_decisions_paper_position_id_fkey"
            columns: ["paper_position_id"]
            isOneToOne: false
            referencedRelation: "paper_positions"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_decisions_archive: {
        Row: {
          algorithm_id: string
          archive_id: string
          archived_at: string
          bar_date: string
          confidence: number | null
          context: Json | null
          created_at: string
          decision: string
          had_position: string
          id: string
          model: string
          paper_position_id: string | null
          prompt_version: string
          provider: string
          reasoning: string | null
          regime: string
          source: string
          trade_outcome: Json | null
          user_id: string
        }
        Insert: {
          algorithm_id: string
          archive_id?: string
          archived_at?: string
          bar_date: string
          confidence?: number | null
          context?: Json | null
          created_at?: string
          decision: string
          had_position: string
          id?: string
          model: string
          paper_position_id?: string | null
          prompt_version: string
          provider: string
          reasoning?: string | null
          regime: string
          source: string
          trade_outcome?: Json | null
          user_id: string
        }
        Update: {
          algorithm_id?: string
          archive_id?: string
          archived_at?: string
          bar_date?: string
          confidence?: number | null
          context?: Json | null
          created_at?: string
          decision?: string
          had_position?: string
          id?: string
          model?: string
          paper_position_id?: string | null
          prompt_version?: string
          provider?: string
          reasoning?: string | null
          regime?: string
          source?: string
          trade_outcome?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      oanda_positioning_cache: {
        Row: {
          bucket_width: number
          buckets: Json
          created_at: string
          fetched_at: string
          id: string
          instrument: string
          long_pct: number
          oanda_time: string
          price: number
          short_pct: number
        }
        Insert: {
          bucket_width: number
          buckets: Json
          created_at?: string
          fetched_at?: string
          id?: string
          instrument: string
          long_pct: number
          oanda_time: string
          price: number
          short_pct: number
        }
        Update: {
          bucket_width?: number
          buckets?: Json
          created_at?: string
          fetched_at?: string
          id?: string
          instrument?: string
          long_pct?: number
          oanda_time?: string
          price?: number
          short_pct?: number
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          algorithm_id: string
          broker_close_id: string | null
          broker_close_price: number | null
          broker_error: string | null
          broker_fill_price: number | null
          broker_order_id: string | null
          broker_pnl_synced_at: string | null
          broker_position_id: string | null
          broker_realized_synced_at: string | null
          broker_unrealized_pnl: number | null
          closed_at: string | null
          created_at: string | null
          current_price: number | null
          entry_price: number
          entry_reason: Json
          exit_price: number | null
          exit_reason: string | null
          id: string
          initial_stop_loss_price: number | null
          notional_value: number
          opened_at: string
          quantity: number
          realized_pnl: number | null
          side: string
          status: string
          stop_loss_price: number | null
          take_profit_price: number | null
          ticker: string
          unrealized_pnl: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          algorithm_id: string
          broker_close_id?: string | null
          broker_close_price?: number | null
          broker_error?: string | null
          broker_fill_price?: number | null
          broker_order_id?: string | null
          broker_pnl_synced_at?: string | null
          broker_position_id?: string | null
          broker_realized_synced_at?: string | null
          broker_unrealized_pnl?: number | null
          closed_at?: string | null
          created_at?: string | null
          current_price?: number | null
          entry_price: number
          entry_reason?: Json
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          initial_stop_loss_price?: number | null
          notional_value: number
          opened_at?: string
          quantity: number
          realized_pnl?: number | null
          side?: string
          status?: string
          stop_loss_price?: number | null
          take_profit_price?: number | null
          ticker: string
          unrealized_pnl?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          algorithm_id?: string
          broker_close_id?: string | null
          broker_close_price?: number | null
          broker_error?: string | null
          broker_fill_price?: number | null
          broker_order_id?: string | null
          broker_pnl_synced_at?: string | null
          broker_position_id?: string | null
          broker_realized_synced_at?: string | null
          broker_unrealized_pnl?: number | null
          closed_at?: string | null
          created_at?: string | null
          current_price?: number | null
          entry_price?: number
          entry_reason?: Json
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          initial_stop_loss_price?: number | null
          notional_value?: number
          opened_at?: string
          quantity?: number
          realized_pnl?: number | null
          side?: string
          status?: string
          stop_loss_price?: number | null
          take_profit_price?: number | null
          ticker?: string
          unrealized_pnl?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_positions_algorithm_id_fkey"
            columns: ["algorithm_id"]
            isOneToOne: false
            referencedRelation: "algorithms"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_positions_archive: {
        Row: {
          algorithm_id: string
          archive_id: string
          archived_at: string
          broker_close_id: string | null
          broker_close_price: number | null
          broker_error: string | null
          broker_fill_price: number | null
          broker_order_id: string | null
          broker_pnl_synced_at: string | null
          broker_position_id: string | null
          broker_realized_synced_at: string | null
          broker_unrealized_pnl: number | null
          closed_at: string | null
          created_at: string | null
          current_price: number | null
          entry_price: number
          entry_reason: Json
          exit_price: number | null
          exit_reason: string | null
          id: string
          initial_stop_loss_price: number | null
          notional_value: number
          opened_at: string
          quantity: number
          realized_pnl: number | null
          side: string
          status: string
          stop_loss_price: number | null
          take_profit_price: number | null
          ticker: string
          unrealized_pnl: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          algorithm_id: string
          archive_id?: string
          archived_at?: string
          broker_close_id?: string | null
          broker_close_price?: number | null
          broker_error?: string | null
          broker_fill_price?: number | null
          broker_order_id?: string | null
          broker_pnl_synced_at?: string | null
          broker_position_id?: string | null
          broker_realized_synced_at?: string | null
          broker_unrealized_pnl?: number | null
          closed_at?: string | null
          created_at?: string | null
          current_price?: number | null
          entry_price: number
          entry_reason?: Json
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          initial_stop_loss_price?: number | null
          notional_value: number
          opened_at?: string
          quantity: number
          realized_pnl?: number | null
          side?: string
          status?: string
          stop_loss_price?: number | null
          take_profit_price?: number | null
          ticker: string
          unrealized_pnl?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          algorithm_id?: string
          archive_id?: string
          archived_at?: string
          broker_close_id?: string | null
          broker_close_price?: number | null
          broker_error?: string | null
          broker_fill_price?: number | null
          broker_order_id?: string | null
          broker_pnl_synced_at?: string | null
          broker_position_id?: string | null
          broker_realized_synced_at?: string | null
          broker_unrealized_pnl?: number | null
          closed_at?: string | null
          created_at?: string | null
          current_price?: number | null
          entry_price?: number
          entry_reason?: Json
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          initial_stop_loss_price?: number | null
          notional_value?: number
          opened_at?: string
          quantity?: number
          realized_pnl?: number | null
          side?: string
          status?: string
          stop_loss_price?: number | null
          take_profit_price?: number | null
          ticker?: string
          unrealized_pnl?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      portfolios: {
        Row: {
          broker_connection_id: string | null
          capital: number
          created_at: string
          id: string
          name: string
          prop_firm_rules: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          broker_connection_id?: string | null
          capital?: number
          created_at?: string
          id?: string
          name: string
          prop_firm_rules?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          broker_connection_id?: string | null
          capital?: number
          created_at?: string
          id?: string
          name?: string
          prop_firm_rules?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolios_broker_connection_id_fkey"
            columns: ["broker_connection_id"]
            isOneToOne: false
            referencedRelation: "broker_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      price_cache: {
        Row: {
          bar_count: number
          bars: Json
          fetched_at: string
          id: string
          interval: string
          output_size: string
          ticker: string
        }
        Insert: {
          bar_count?: number
          bars?: Json
          fetched_at?: string
          id?: string
          interval?: string
          output_size?: string
          ticker: string
        }
        Update: {
          bar_count?: number
          bars?: Json
          fetched_at?: string
          id?: string
          interval?: string
          output_size?: string
          ticker?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          autonomy_level: string
          avatar_url: string | null
          created_at: string | null
          default_currency: string | null
          email: string
          full_name: string | null
          id: string
          onboarding_completed: boolean | null
          prop_firm_preset: string | null
          subscription_tier: string | null
          timezone: string | null
          trading_profile: Json | null
          updated_at: string | null
        }
        Insert: {
          autonomy_level?: string
          avatar_url?: string | null
          created_at?: string | null
          default_currency?: string | null
          email: string
          full_name?: string | null
          id: string
          onboarding_completed?: boolean | null
          prop_firm_preset?: string | null
          subscription_tier?: string | null
          timezone?: string | null
          trading_profile?: Json | null
          updated_at?: string | null
        }
        Update: {
          autonomy_level?: string
          avatar_url?: string | null
          created_at?: string | null
          default_currency?: string | null
          email?: string
          full_name?: string | null
          id?: string
          onboarding_completed?: boolean | null
          prop_firm_preset?: string | null
          subscription_tier?: string | null
          timezone?: string | null
          trading_profile?: Json | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sentiment_cache: {
        Row: {
          article_count: number
          articles: Json
          avg_sentiment: number
          bearish_count: number
          bullish_count: number
          fetched_at: string
          id: string
          ticker: string
          topic_distribution: Json
          topics: string[] | null
          user_id: string
        }
        Insert: {
          article_count: number
          articles?: Json
          avg_sentiment: number
          bearish_count: number
          bullish_count: number
          fetched_at?: string
          id?: string
          ticker: string
          topic_distribution?: Json
          topics?: string[] | null
          user_id: string
        }
        Update: {
          article_count?: number
          articles?: Json
          avg_sentiment?: number
          bearish_count?: number
          bullish_count?: number
          fetched_at?: string
          id?: string
          ticker?: string
          topic_distribution?: Json
          topics?: string[] | null
          user_id?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          description: string
          id: string
          name: string
          rules_template: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          name: string
          rules_template?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          name?: string
          rules_template?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          asset_class: string
          commission: number | null
          created_at: string | null
          currency: string | null
          entry_date: string
          entry_price: number
          exit_date: string | null
          exit_price: number | null
          fees: number | null
          id: string
          notes: string | null
          quantity: number
          realized_pnl: number | null
          side: string
          status: string
          strategy: string | null
          symbol: string
          tags: string[] | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          asset_class?: string
          commission?: number | null
          created_at?: string | null
          currency?: string | null
          entry_date: string
          entry_price: number
          exit_date?: string | null
          exit_price?: number | null
          fees?: number | null
          id?: string
          notes?: string | null
          quantity: number
          realized_pnl?: number | null
          side: string
          status?: string
          strategy?: string | null
          symbol: string
          tags?: string[] | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          asset_class?: string
          commission?: number | null
          created_at?: string | null
          currency?: string | null
          entry_date?: string
          entry_price?: number
          exit_date?: string | null
          exit_price?: number | null
          fees?: number | null
          id?: string
          notes?: string | null
          quantity?: number
          realized_pnl?: number | null
          side?: string
          status?: string
          strategy?: string | null
          symbol?: string
          tags?: string[] | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      last_manage_tick: { Args: never; Returns: string }
      last_scan_tick: { Args: never; Returns: string }
      prune_sentiment_cache: {
        Args: { retention_days?: number }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
