import { all, first } from "./db";

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const BODY_COLS = ["weight_kg", "body_fat_pct", "muscle_mass_kg", "visceral_fat", "water_pct", "bmi", "skeletal_muscle_pct"];
const DAILY_METRICS = ["steps", "resting_hr", "sleep_minutes", "active_minutes", "hrv_ms", "calories_out", "active_zone_minutes"];

export const GOAL_METRICS = [...BODY_COLS, ...DAILY_METRICS, "net_calories", "calories_in", "protein_g", "exercise_calories"];

/** Latest weight in kg from the scale table, falling back to tracker-imported weight. */
export async function latestWeight(db: D1Database): Promise<{ date: string; value: number } | null> {
  const a = await first<{ date: string; value: number }>(
    db,
    "SELECT date, weight_kg AS value FROM body_measurements WHERE weight_kg IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1",
  );
  const b = await first<{ date: string; value: number }>(
    db,
    "SELECT date, value FROM daily_metrics WHERE metric='weight_kg' ORDER BY date DESC LIMIT 1",
  );
  if (a && b) return a.date >= b.date ? a : b;
  return a ?? b;
}

/** Per-day values for a metric over [from, to]. One value per date. */
export async function dailySeries(db: D1Database, metric: string, from: string, to: string): Promise<{ date: string; value: number }[]> {
  if (BODY_COLS.includes(metric)) {
    // last reading of each day
    return all(
      db,
      `SELECT date, ${metric} AS value FROM body_measurements b
       WHERE ${metric} IS NOT NULL AND date BETWEEN ? AND ?
         AND id = (SELECT id FROM body_measurements b2 WHERE b2.date=b.date AND b2.${metric} IS NOT NULL ORDER BY COALESCE(time,'') DESC, id DESC LIMIT 1)
       UNION
       SELECT date, value FROM daily_metrics WHERE metric=? AND date BETWEEN ? AND ?
         AND date NOT IN (SELECT date FROM body_measurements WHERE ${metric} IS NOT NULL)
       ORDER BY date`,
      from, to, metric, from, to,
    );
  }
  if (metric === "calories_in" || metric === "protein_g") {
    const col = metric === "calories_in" ? "calories" : "protein_g";
    return all(db, `SELECT date, SUM(COALESCE(${col},0)) AS value FROM food_entries WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date`, from, to);
  }
  if (metric === "exercise_calories") {
    return all(db, "SELECT date, SUM(calories) AS value FROM exercise_entries WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date", from, to);
  }
  if (metric === "net_calories") {
    return all(
      db,
      `SELECT f.date AS date, f.cal - COALESCE(e.cal, 0) AS value
       FROM (SELECT date, SUM(calories) cal FROM food_entries WHERE date BETWEEN ? AND ? GROUP BY date) f
       LEFT JOIN (SELECT date, SUM(calories) cal FROM exercise_entries WHERE date BETWEEN ? AND ? GROUP BY date) e ON e.date=f.date
       ORDER BY f.date`,
      from, to, from, to,
    );
  }
  if (metric.startsWith("lab:")) {
    return all(db, "SELECT date, value FROM lab_results WHERE test_key=? AND value IS NOT NULL AND date BETWEEN ? AND ? ORDER BY date", metric.slice(4), from, to);
  }
  // tracker metrics: if several sources wrote the same day, take the max (e.g. steps)
  return all(db, "SELECT date, MAX(value) AS value FROM daily_metrics WHERE metric=? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date", metric, from, to);
}

/** Current value used for goal progress. Body/lab metrics: latest reading. Daily metrics: 7-day average. */
export async function currentValue(db: D1Database, metric: string, today: string): Promise<number | null> {
  if (BODY_COLS.includes(metric) || metric.startsWith("lab:")) {
    if (metric === "weight_kg") return (await latestWeight(db))?.value ?? null;
    const s = await dailySeries(db, metric, "1900-01-01", today);
    return s.length ? s[s.length - 1].value : null;
  }
  const s = await dailySeries(db, metric, addDays(today, -6), today);
  if (!s.length) return null;
  return s.reduce((a, r) => a + r.value, 0) / s.length;
}

export interface GoalRow {
  id: number;
  title: string;
  metric: string;
  kind: "target" | "daily";
  direction: "down" | "up";
  start_value: number | null;
  target_value: number;
  start_date: string;
  target_date: string | null;
  status: string;
  notes: string | null;
}

export async function goalProgress(db: D1Database, g: GoalRow, today: string) {
  const current = await currentValue(db, g.metric, today);
  const out: Record<string, unknown> = { ...g, current };
  if (g.kind === "daily") {
    const s = await dailySeries(db, g.metric, addDays(today, -6), today);
    const hit = s.filter((r) => (g.direction === "down" ? r.value <= g.target_value : r.value >= g.target_value)).length;
    out.days_hit_last_7 = hit;
    out.days_logged_last_7 = s.length;
    out.progress_pct = Math.round((hit / 7) * 100);
    return out;
  }
  if (current == null || g.start_value == null || g.start_value === g.target_value) return out;
  const pct = ((g.start_value - current) / (g.start_value - g.target_value)) * 100;
  out.progress_pct = Math.max(0, Math.min(100, Math.round(pct)));
  out.remaining = +(g.target_value - current).toFixed(2);
  if (g.target_date) {
    const total = daysBetween(g.start_date, g.target_date);
    const elapsed = daysBetween(g.start_date, today);
    const expected = total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 100;
    out.expected_pct = Math.round(expected);
    out.days_left = daysBetween(today, g.target_date);
    out.on_track = pct >= expected - 5;
    if (out.days_left as number > 0) {
      out.required_per_week = +(((g.target_value - current) / (out.days_left as number)) * 7).toFixed(2);
    }
  }
  return out;
}
