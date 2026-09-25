import { pool } from "../config/db";
import { toDateOnly } from "./numbering.service";

/**
 * Aggregates for the dashboard overview and analytics pages. Every number is a
 * SQL aggregate over the factory's own rows -- nothing here is estimated.
 */

export interface DashboardStats {
  totalCustomers: number;
  newCustomersThisMonth: number;
  activeConversations: number;
  unreadConversations: number;
  totalQuotations: number;
  pendingQuotations: number;
  expiringSoon: number;
  ordersThisMonth: number;
  revenueThisMonth: number;
  openOrders: number;
  totalRevenue: number;
  currency: string;
}

export async function getStats(factoryId: string): Promise<DashboardStats> {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM leads WHERE factory_id = $1) AS total_customers,
       (SELECT COUNT(*) FROM leads
          WHERE factory_id = $1
            AND created_at >= date_trunc('month', NOW())) AS new_customers_this_month,
       (SELECT COUNT(*) FROM chat_sessions WHERE factory_id = $1) AS active_conversations,
       (SELECT COUNT(*) FROM chat_sessions
          WHERE factory_id = $1
            AND last_active_at >= NOW() - INTERVAL '24 hours') AS unread_conversations,
       (SELECT COUNT(*) FROM quotations WHERE factory_id = $1) AS total_quotations,
       (SELECT COUNT(*) FROM quotations
          WHERE factory_id = $1
            AND status IN ('draft','pending','sent')) AS pending_quotations,
       (SELECT COUNT(*) FROM quotations
          WHERE factory_id = $1
            AND status IN ('draft','pending','sent')
            AND valid_until IS NOT NULL
            AND valid_until <= (NOW() + INTERVAL '7 days')::DATE) AS expiring_soon,
       (SELECT COUNT(*) FROM orders
          WHERE factory_id = $1
            AND created_at >= date_trunc('month', NOW())) AS orders_this_month,
       (SELECT COALESCE(SUM(total_price), 0) FROM orders
          WHERE factory_id = $1
            AND created_at >= date_trunc('month', NOW())) AS revenue_this_month,
       (SELECT COUNT(*) FROM orders
          WHERE factory_id = $1
            AND status NOT IN ('completed')) AS open_orders,
       (SELECT COALESCE(SUM(total_price), 0) FROM orders
          WHERE factory_id = $1) AS total_revenue,
       (SELECT COALESCE(default_currency, 'USD') FROM factories WHERE id = $1) AS currency`,
    [factoryId]
  );

  const row = result.rows[0];
  return {
    totalCustomers: Number(row.total_customers),
    newCustomersThisMonth: Number(row.new_customers_this_month),
    activeConversations: Number(row.active_conversations),
    unreadConversations: Number(row.unread_conversations),
    totalQuotations: Number(row.total_quotations),
    pendingQuotations: Number(row.pending_quotations),
    expiringSoon: Number(row.expiring_soon),
    ordersThisMonth: Number(row.orders_this_month),
    revenueThisMonth: Number(row.revenue_this_month),
    openOrders: Number(row.open_orders),
    totalRevenue: Number(row.total_revenue),
    currency: row.currency || "USD",
  };
}

export interface AnalyticsPoint {
  date: string;
  inquiries: number;
  quotations: number;
  orders: number;
  revenue: number;
}

/**
 * Daily series over the last `days` days. Uses generate_series so days with no
 * activity come back as zeros rather than gaps the chart would have to guess at.
 */
export async function getAnalytics(
  factoryId: string,
  days = 30
): Promise<AnalyticsPoint[]> {
  const span = Math.min(365, Math.max(7, Math.round(days)));
  const result = await pool.query(
    `WITH span AS (
       SELECT generate_series(
         (NOW() - ($2 || ' days')::INTERVAL)::DATE,
         NOW()::DATE,
         '1 day'::INTERVAL
       )::DATE AS day
     )
     SELECT
       span.day,
       (SELECT COUNT(*) FROM leads
          WHERE factory_id = $1 AND created_at::DATE = span.day) AS inquiries,
       (SELECT COUNT(*) FROM quotations
          WHERE factory_id = $1 AND created_at::DATE = span.day) AS quotations,
       (SELECT COUNT(*) FROM orders
          WHERE factory_id = $1 AND created_at::DATE = span.day) AS orders,
       (SELECT COALESCE(SUM(total_price), 0) FROM orders
          WHERE factory_id = $1 AND created_at::DATE = span.day) AS revenue
     FROM span
     ORDER BY span.day ASC`,
    [factoryId, String(span)]
  );

  return result.rows.map((row) => ({
    date: toDateOnly(row.day)!,
    inquiries: Number(row.inquiries),
    quotations: Number(row.quotations),
    orders: Number(row.orders),
    revenue: Number(row.revenue),
  }));
}

/** Status breakdown used by the conversion / funnel charts. */
export async function getFunnel(factoryId: string) {
  const [quotes, orders] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM quotations
       WHERE factory_id = $1 GROUP BY status`,
      [factoryId]
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM orders
       WHERE factory_id = $1 GROUP BY status`,
      [factoryId]
    ),
  ]);

  return {
    quotationsByStatus: quotes.rows.map((r) => ({
      status: r.status as string,
      count: r.count as number,
    })),
    ordersByStatus: orders.rows.map((r) => ({
      status: r.status as string,
      count: r.count as number,
    })),
  };
}
