# Health & Fitness tracker: notes for Claude sessions

The owner logs health data by sharing it with Claude in chat. Claude extracts the values and writes them
**directly to the Cloudflare D1 database**. The app's web pages are only used to view the dashboard. The Worker has
no `ANTHROPIC_API_KEY`, so do not use the `/api/ai/*` endpoints.

## Database

- D1 database `healthnfitness`, id `7d6aaaf1-6304-4241-bb3e-58b965f8eed8`, in the owner's Cloudflare account.
- Write with the Cloudflare connector's `d1_database_query` tool (pass values via `params`, not string concatenation).
- Schema: `migrations/0001_init.sql`. It is already applied, and recorded in `d1_migrations`.
- New schema changes go in a new migration file. Apply that file with `d1_database_query` and insert its name into
  `d1_migrations`.

## Conventions

- Units: metric only (kg, cm, km, mmol/L as printed on the lab report). Dates: `YYYY-MM-DD`, in the owner's local day
  (Canada). Use today's date unless told otherwise; ask if a photo seems to be from another day.
- `source` values: `claude-photo`, `claude-text`, `claude-pdf`, `fitbit`, `fitbod`, `manual`.
- **Food** (`food_entries`): one row per meal. Fill in `calories`, `protein_g`, `carbs_g`, `fat_g` and `fiber_g`, plus
  `items_json` (a JSON array of `{name, portion, calories, protein_g, carbs_g, fat_g}`). Account for cooking oil and
  sauces. State your assumptions.
- **Scale** (`body_measurements`): copy the numbers exactly as shown and convert lb to kg. Use NULL for anything not shown.
- **Blood tests**: insert one `lab_reports` row, then the `lab_results` rows with the same `date`. `test_key` is a
  stable snake_case name (`ldl_cholesterol`, `hba1c`, `tsh`, `vitamin_d_25oh`, `fasting_glucose`, `alt`,
  `ferritin`, ...), so that markers trend across different labs. Check existing keys first:
  `SELECT DISTINCT test_key, test_name FROM lab_results`. `flag` is one of low | high | normal | abnormal | unknown.
- **Exercise** (`exercise_entries`): use the device's calories when shown. Otherwise estimate active kcal =
  (MET − 1) × kg × hours, using the latest weight. For Fitbod imports, set `external_id = 'fitbod-YYYY-MM-DD'` and use
  `INSERT OR IGNORE`.
- **Tracker vitals** (`daily_metrics`): use `INSERT OR REPLACE` keyed on (date, metric, source). Metric names are
  listed in `src/ai.ts` (`VitalsReport`). For big Takeout exports, parse them with a script that mirrors
  `parseHealthFile` in `public/app.js`, and insert in batches.

## Workflow

1. Extract the values and show the owner a short table: calories and macros, scale values, or lab results with any
   flags.
2. Write to D1 once the owner confirms, unless they said to save directly. For blood tests, always confirm first.
3. Reply in one line saying what was saved, plus the day's running totals (food kcal, exercise kcal, remaining vs
   `settings.calorie_target`).
4. Questions like "how am I doing?" are answered by querying D1. These are not medical diagnoses; point out values
   that are out of range and suggest seeing a doctor where relevant.
