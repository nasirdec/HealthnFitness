import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./types";
import { all, bulkStatements, first, insertRow, MAX_BULK_ROWS, run, updateRow, type Row } from "./db";
import { addDays, currentValue, dailySeries, goalProgress, latestWeight, type GoalRow } from "./goals";
import {
  AIError,
  estimateExercise,
  estimateFood,
  extractLabs,
  extractScale,
  extractVitals,
  generateInsights,
  type Attachment,
} from "./ai";

const app = new Hono<{ Bindings: Env }>();

const FOOD_COLS = ["date", "time", "meal", "description", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "items_json", "source"];
const EXERCISE_COLS = ["date", "name", "category", "duration_min", "calories", "details_json", "source", "external_id"];
const BODY_COLS = [
  "date", "time", "weight_kg", "bmi", "body_fat_pct", "muscle_mass_kg", "skeletal_muscle_pct", "water_pct", "bone_mass_kg",
  "visceral_fat", "protein_pct", "bmr_kcal", "metabolic_age", "source", "notes", "extra_json",
];
const GOAL_COLS = ["title", "metric", "kind", "direction", "start_value", "target_value", "start_date", "target_date", "status", "notes"];
const LAB_RESULT_COLS = ["report_id", "date", "panel", "test_name", "test_key", "value", "value_text", "unit", "ref_low", "ref_high", "ref_text", "flag"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function today(c: Context): string {
  const q = c.req.query("today");
  return q && DATE_RE.test(q) ? q : new Date().toISOString().slice(0, 10);
}

function requireDate(v: unknown, field = "date"): string {
  if (typeof v !== "string" || !DATE_RE.test(v)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return v;
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid id");
  return id;
}

function range(c: Context, defaultDays = 30) {
  const to = c.req.query("to") ?? today(c);
  const from = c.req.query("from") ?? addDays(to, -(defaultDays - 1));
  return { from: requireDate(from, "from"), to: requireDate(to, "to") };
}

async function getSettings(db: D1Database): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ------------------------------------------------------------------ auth & errors

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

app.get("/api/health", (c) => c.json({ ok: true, ai: Boolean(c.env.ANTHROPIC_API_KEY), model: c.env.CLAUDE_MODEL }));

app.use("/api/*", async (c, next) => {
  if (!c.env.APP_TOKEN) return c.json({ error: "APP_TOKEN secret is not set on the Worker." }, 503);
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(token, c.env.APP_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.onError((err, c) => {
  if (err instanceof HttpError || err instanceof AIError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
});

// ------------------------------------------------------------------ settings

app.get("/api/settings", async (c) => c.json(await getSettings(c.env.DB)));

app.put("/api/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const rows = Object.entries(body)
    .filter(([k]) => /^[a-z_]{1,40}$/.test(k))
    .map(([k, v]) => [k, String(v ?? "")]);
  if (rows.length) await c.env.DB.batch(bulkStatements(c.env.DB, "INSERT OR REPLACE", "settings", ["key", "value"], rows));
  return c.json(await getSettings(c.env.DB));
});

/** Mifflin-St Jeor BMR from profile + latest weight. */
async function estimateBmr(db: D1Database, s: Record<string, string>): Promise<number | null> {
  const w = await latestWeight(db);
  const h = Number(s.height_cm);
  const age = s.birth_year ? new Date().getUTCFullYear() - Number(s.birth_year) : NaN;
  if (!w || !h || !age) return null;
  const base = 10 * w.value + 6.25 * h - 5 * age;
  return Math.round(s.sex === "female" ? base - 161 : base + 5);
}

// ------------------------------------------------------------------ dashboard

app.get("/api/day/:date", async (c) => {
  const date = requireDate(c.req.param("date"));
  const db = c.env.DB;
  const [food, exercise, metrics, body, settings] = await Promise.all([
    all(db, "SELECT * FROM food_entries WHERE date=? ORDER BY COALESCE(time,''), id", date),
    all(db, "SELECT * FROM exercise_entries WHERE date=? ORDER BY id", date),
    all(db, "SELECT metric, MAX(value) AS value, unit, GROUP_CONCAT(DISTINCT source) AS source FROM daily_metrics WHERE date=? GROUP BY metric", date),
    all(db, "SELECT * FROM body_measurements WHERE date=? ORDER BY COALESCE(time,''), id", date),
    getSettings(db),
  ]);
  const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const calIn = sum(food, "calories");
  const calEx = sum(exercise, "calories");
  const bmr = await estimateBmr(db, settings);
  const target = settings.calorie_target ? Number(settings.calorie_target) : null;
  const eatBack = settings.eat_back_exercise !== "false";
  const trackerOut = (metrics as Row[]).find((m) => m.metric === "calories_out")?.value as number | undefined;
  return c.json({
    date,
    food,
    exercise,
    metrics,
    body,
    totals: {
      calories_in: Math.round(calIn),
      protein_g: Math.round(sum(food, "protein_g")),
      carbs_g: Math.round(sum(food, "carbs_g")),
      fat_g: Math.round(sum(food, "fat_g")),
      fiber_g: Math.round(sum(food, "fiber_g")),
      exercise_calories: Math.round(calEx),
      net_calories: Math.round(calIn - calEx),
      calorie_target: target,
      protein_target: settings.protein_target ? Number(settings.protein_target) : null,
      remaining: target != null ? Math.round(target - calIn + (eatBack ? calEx : 0)) : null,
      bmr,
      tracker_calories_out: trackerOut ?? null,
      // Energy balance vs total burn from the tracker (already includes workouts it detected)
      tracker_balance: trackerOut != null ? Math.round(calIn - trackerOut) : null,
    },
  });
});

app.get("/api/trends", async (c) => {
  const { from, to } = range(c, Number(c.req.query("days") ?? 90));
  const metrics = (c.req.query("metrics") ?? "weight_kg,body_fat_pct,calories_in,exercise_calories,net_calories,steps,resting_hr,sleep_minutes")
    .split(",")
    .filter(Boolean)
    .slice(0, 12);
  const out: Record<string, unknown> = { from, to };
  for (const m of metrics) out[m] = await dailySeries(c.env.DB, m, from, to);
  return c.json(out);
});

// ------------------------------------------------------------------ generic CRUD for food / exercise / body

function crud(path: string, table: string, cols: string[], validate: (d: Row) => Row) {
  app.get(`/api/${path}`, async (c) => {
    const { from, to } = range(c, 30);
    return c.json(await all(c.env.DB, `SELECT * FROM ${table} WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC`, from, to));
  });
  app.post(`/api/${path}`, async (c) => {
    const body = await c.req.json<Row | Row[]>();
    const items = Array.isArray(body) ? body : [body];
    if (items.length > MAX_BULK_ROWS) throw new HttpError(413, `max ${MAX_BULK_ROWS} rows per request`);
    const clean = items.map(validate);
    if (clean.length === 1 && clean[0].external_id == null) {
      const id = await insertRow(c.env.DB, table, cols, clean[0]);
      return c.json({ id, inserted: 1 }, 201);
    }
    const rows = clean.map((r) => cols.map((k) => r[k] ?? null));
    const verb = cols.includes("external_id") ? "INSERT OR IGNORE" : "INSERT";
    const res = await c.env.DB.batch(bulkStatements(c.env.DB, verb, table, cols, rows));
    return c.json({ inserted: res.reduce((a, r) => a + (r.meta.changes ?? 0), 0) }, 201);
  });
  app.put(`/api/${path}/:id`, async (c) => {
    const id = idParam(c);
    const body = await c.req.json<Row>();
    if (body.date !== undefined) requireDate(body.date);
    await updateRow(c.env.DB, table, cols, id, body);
    return c.json(await first(c.env.DB, `SELECT * FROM ${table} WHERE id=?`, id));
  });
  app.delete(`/api/${path}/:id`, async (c) => {
    await run(c.env.DB, `DELETE FROM ${table} WHERE id=?`, idParam(c));
    return c.json({ ok: true });
  });
}

const jsonField = (v: unknown) => (v == null || typeof v === "string" ? v : JSON.stringify(v));

crud("food", "food_entries", FOOD_COLS, (d) => {
  requireDate(d.date);
  if (!d.description) throw new HttpError(400, "description is required");
  return { ...d, calories: Number(d.calories) || 0, items_json: jsonField(d.items_json ?? d.items), source: d.source ?? "manual" };
});

crud("exercise", "exercise_entries", EXERCISE_COLS, (d) => {
  requireDate(d.date);
  if (!d.name) throw new HttpError(400, "name is required");
  return { ...d, calories: Number(d.calories) || 0, details_json: jsonField(d.details_json ?? d.details), source: d.source ?? "manual" };
});

crud("body", "body_measurements", BODY_COLS, (d) => {
  requireDate(d.date);
  return { ...d, extra_json: jsonField(d.extra_json ?? d.other), source: d.source ?? "manual" };
});

// ------------------------------------------------------------------ daily metrics (tracker data)

app.get("/api/metrics", async (c) => {
  const { from, to } = range(c, 30);
  const metric = c.req.query("metric");
  return c.json(
    metric
      ? await dailySeries(c.env.DB, metric, from, to)
      : await all(c.env.DB, "SELECT * FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date DESC, metric", from, to),
  );
});

/** Upsert tracker metrics: [{date, metric, value, unit?, source?}] */
app.post("/api/metrics", async (c) => {
  const body = await c.req.json<Row[] | { rows: Row[] }>();
  const items = Array.isArray(body) ? body : body.rows;
  if (!Array.isArray(items)) throw new HttpError(400, "expected an array of {date, metric, value}");
  if (items.length > MAX_BULK_ROWS) throw new HttpError(413, `max ${MAX_BULK_ROWS} rows per request`);
  const rows = items
    .filter((r) => DATE_RE.test(String(r.date)) && typeof r.metric === "string" && Number.isFinite(Number(r.value)))
    .map((r) => [r.date, r.metric, Number(r.value), r.unit ?? null, r.source ?? "manual"]);
  if (rows.length) {
    await c.env.DB.batch(bulkStatements(c.env.DB, "INSERT OR REPLACE", "daily_metrics", ["date", "metric", "value", "unit", "source"], rows));
  }
  return c.json({ upserted: rows.length, skipped: items.length - rows.length });
});

app.delete("/api/metrics", async (c) => {
  const { date, metric, source } = c.req.query();
  requireDate(date);
  await run(c.env.DB, "DELETE FROM daily_metrics WHERE date=? AND metric=? AND (? IS NULL OR source=?)", date, metric, source ?? null, source ?? null);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ labs

async function saveLabReport(db: D1Database, report: Row & { results: Row[] }) {
  const date = requireDate(report.date ?? report.report_date, "report date");
  const reportId = await insertRow(db, "lab_reports", ["date", "lab_name", "summary"], {
    date,
    lab_name: report.lab_name ?? null,
    summary: report.summary ?? null,
  });
  const rows = (report.results ?? [])
    .filter((r) => r.test_name)
    .map((r) =>
      LAB_RESULT_COLS.map((k) => {
        if (k === "report_id") return reportId;
        if (k === "date") return date;
        if (k === "test_key") return String(r.test_key || r.test_name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        return r[k] ?? null;
      }),
    );
  if (rows.length) await db.batch(bulkStatements(db, "INSERT", "lab_results", LAB_RESULT_COLS, rows));
  return { id: reportId, results: rows.length };
}

app.get("/api/labs", async (c) => {
  const reports = await all<Row>(c.env.DB, "SELECT * FROM lab_reports ORDER BY date DESC, id DESC");
  const results = await all<Row>(c.env.DB, "SELECT * FROM lab_results ORDER BY COALESCE(panel,''), test_name");
  return c.json(reports.map((r) => ({ ...r, results: results.filter((x) => x.report_id === r.id) })));
});

app.post("/api/labs", async (c) => c.json(await saveLabReport(c.env.DB, await c.req.json()), 201));

app.delete("/api/labs/:id", async (c) => {
  const id = idParam(c);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM lab_results WHERE report_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM lab_reports WHERE id=?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.put("/api/lab-results/:id", async (c) => {
  const id = idParam(c);
  await updateRow(c.env.DB, "lab_results", LAB_RESULT_COLS.filter((k) => k !== "report_id"), id, await c.req.json());
  return c.json(await first(c.env.DB, "SELECT * FROM lab_results WHERE id=?", id));
});

app.get("/api/labs/trend/:key", async (c) =>
  c.json(await all(c.env.DB, "SELECT date, value, value_text, unit, ref_low, ref_high, flag FROM lab_results WHERE test_key=? ORDER BY date", c.req.param("key"))),
);

// ------------------------------------------------------------------ goals

app.get("/api/goals", async (c) => {
  const goals = await all<GoalRow>(c.env.DB, "SELECT * FROM goals WHERE status != 'archived' ORDER BY status, id DESC");
  const t = today(c);
  return c.json(await Promise.all(goals.map((g) => goalProgress(c.env.DB, g, t))));
});

app.post("/api/goals", async (c) => {
  const d = await c.req.json<Row>();
  if (!d.title || !d.metric || d.target_value == null) throw new HttpError(400, "title, metric and target_value are required");
  const t = today(c);
  const start_date = d.start_date ? requireDate(d.start_date, "start_date") : t;
  if (d.target_date) requireDate(d.target_date, "target_date");
  const start_value = d.start_value ?? (await currentValue(c.env.DB, String(d.metric), t));
  const direction = d.direction ?? (start_value != null && Number(d.target_value) > Number(start_value) ? "up" : "down");
  const id = await insertRow(c.env.DB, "goals", GOAL_COLS, { ...d, start_date, start_value, direction, kind: d.kind ?? "target" });
  return c.json({ id }, 201);
});

app.put("/api/goals/:id", async (c) => {
  const id = idParam(c);
  await updateRow(c.env.DB, "goals", GOAL_COLS, id, await c.req.json());
  return c.json(await first(c.env.DB, "SELECT * FROM goals WHERE id=?", id));
});

app.delete("/api/goals/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM goals WHERE id=?", idParam(c));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ AI extraction
// Each endpoint returns a preview for the user to review. Pass {"save": true, "date": "..."} to persist
// directly (handy for scripts/agents posting data).

interface AIRequest {
  text?: string;
  files?: Attachment[];
  save?: boolean;
  date?: string;
  time?: string;
}

async function aiBody(c: Context): Promise<AIRequest> {
  const b = await c.req.json<AIRequest>();
  b.files = (b.files ?? []).map((f) => ({ media_type: f.media_type, data: String(f.data).replace(/^data:[^,]+,/, "") }));
  if (!b.text?.trim() && !b.files.length) throw new HttpError(400, "send text and/or files");
  return b;
}

app.post("/api/ai/food", async (c) => {
  const b = await aiBody(c);
  const est = await estimateFood(c.env, b.text ?? "", b.files ?? []);
  if (!b.save) return c.json(est);
  const id = await insertRow(c.env.DB, "food_entries", FOOD_COLS, {
    date: requireDate(b.date ?? today(c)),
    time: b.time ?? null,
    meal: est.meal,
    description: est.description,
    ...est.total,
    items_json: JSON.stringify(est.items),
    source: b.files?.length ? "ai-photo" : "ai-text",
  });
  return c.json({ ...est, saved_id: id }, 201);
});

app.post("/api/ai/scale", async (c) => {
  const b = await aiBody(c);
  const r = await extractScale(c.env, b.files ?? [], b.text ?? "");
  if (!b.save) return c.json(r);
  const { other, notes, ...vals } = r;
  const id = await insertRow(c.env.DB, "body_measurements", BODY_COLS, {
    ...vals,
    date: requireDate(b.date ?? r.date ?? today(c)),
    time: b.time ?? r.time,
    notes,
    extra_json: JSON.stringify(other),
    source: "ai-scale",
  });
  return c.json({ ...r, saved_id: id }, 201);
});

app.post("/api/ai/labs", async (c) => {
  const b = await aiBody(c);
  const r = await extractLabs(c.env, b.files ?? []);
  if (!b.save) return c.json(r);
  const saved = await saveLabReport(c.env.DB, { ...r, date: b.date ?? r.report_date } as Row & { results: Row[] });
  return c.json({ ...r, saved }, 201);
});

app.post("/api/ai/exercise", async (c) => {
  const b = await aiBody(c);
  const w = await latestWeight(c.env.DB);
  const r = await estimateExercise(c.env, b.text ?? "", b.files ?? [], w?.value ?? null);
  if (!b.save) return c.json(r);
  const d = b.date ?? today(c);
  const ids = [];
  for (const a of r.activities) {
    ids.push(
      await insertRow(c.env.DB, "exercise_entries", EXERCISE_COLS, {
        date: requireDate(a.date ?? d),
        name: a.name,
        category: a.category,
        duration_min: a.duration_min,
        calories: a.calories,
        details_json: JSON.stringify({ details: a.details, calories_source: a.calories_source }),
        source: "ai",
      }),
    );
  }
  return c.json({ ...r, saved_ids: ids }, 201);
});

app.post("/api/ai/vitals", async (c) => {
  const b = await aiBody(c);
  if ((b.text?.length ?? 0) > 400_000) throw new HttpError(413, "Text too large for AI parsing; use the built-in Fitbit importer.");
  const r = await extractVitals(c.env, b.text ?? "", b.files ?? []);
  if (!b.save) return c.json(r);
  const rows = r.days.flatMap((d) => d.metrics.map((m) => [d.date, m.metric, m.value, null, "ai-import"]));
  if (rows.length) {
    await c.env.DB.batch(bulkStatements(c.env.DB, "INSERT OR REPLACE", "daily_metrics", ["date", "metric", "value", "unit", "source"], rows.slice(0, MAX_BULK_ROWS)));
  }
  return c.json({ ...r, upserted: Math.min(rows.length, MAX_BULK_ROWS) }, 201);
});

// ------------------------------------------------------------------ insights

async function buildSummary(db: D1Database, t: string) {
  const from = addDays(t, -29);
  const metrics = ["weight_kg", "body_fat_pct", "muscle_mass_kg", "calories_in", "protein_g", "exercise_calories", "steps", "resting_hr", "sleep_minutes", "hrv_ms", "calories_out"];
  const series: Record<string, unknown> = {};
  for (const m of metrics) series[m] = await dailySeries(db, m, from, t);
  const goals = await all<GoalRow>(db, "SELECT * FROM goals WHERE status='active'");
  const labs = await all(
    db,
    `SELECT r.date, r.test_name, r.value, r.value_text, r.unit, r.ref_low, r.ref_high, r.flag FROM lab_results r
     WHERE r.date >= ? ORDER BY r.test_key, r.date`,
    addDays(t, -730),
  );
  const settings = await getSettings(db);
  return {
    today: t,
    profile: settings,
    bmr_estimate: await estimateBmr(db, settings),
    last_30_days: series,
    recent_workouts: await all(db, "SELECT date, name, duration_min, calories FROM exercise_entries WHERE date >= ? ORDER BY date", from),
    goals: await Promise.all(goals.map((g) => goalProgress(db, g, t))),
    lab_results_last_2_years: labs,
  };
}

app.get("/api/insights", async (c) => c.json(await all(c.env.DB, "SELECT * FROM insights ORDER BY id DESC LIMIT 10")));

app.post("/api/insights", async (c) => {
  const summary = await buildSummary(c.env.DB, today(c));
  const content = await generateInsights(c.env, JSON.stringify(summary));
  const id = await insertRow(c.env.DB, "insights", ["content"], { content });
  return c.json({ id, content, created_at: new Date().toISOString() }, 201);
});

// ------------------------------------------------------------------ backup

app.get("/api/export", async (c) => {
  const tables = ["settings", "daily_metrics", "body_measurements", "food_entries", "exercise_entries", "lab_reports", "lab_results", "goals", "insights"];
  const out: Record<string, unknown> = { exported_at: new Date().toISOString() };
  for (const t of tables) out[t] = await all(c.env.DB, `SELECT * FROM ${t}`);
  return c.json(out);
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default app;
