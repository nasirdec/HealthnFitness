-- Key/value profile settings (height_cm, sex, birth_year, calorie_target, ...)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Daily vitals in long format: one row per (date, metric, source).
-- metrics: steps, resting_hr, calories_out, active_minutes, distance_km, sleep_minutes,
--          sleep_score, hrv_ms, spo2_pct, breathing_rate, floors, vo2max, ...
CREATE TABLE daily_metrics (
  date   TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  REAL NOT NULL,
  unit   TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (date, metric, source)
);
CREATE INDEX idx_metrics_metric_date ON daily_metrics(metric, date);

-- Smart scale / body composition readings
CREATE TABLE body_measurements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT NOT NULL,
  time             TEXT,
  weight_kg        REAL,
  bmi              REAL,
  body_fat_pct     REAL,
  muscle_mass_kg   REAL,
  skeletal_muscle_pct REAL,
  water_pct        REAL,
  bone_mass_kg     REAL,
  visceral_fat     REAL,
  protein_pct      REAL,
  bmr_kcal         REAL,
  metabolic_age    REAL,
  source           TEXT NOT NULL DEFAULT 'manual',
  notes            TEXT,
  extra_json       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_body_date ON body_measurements(date);

CREATE TABLE food_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  time        TEXT,
  meal        TEXT,
  description TEXT NOT NULL,
  calories    REAL NOT NULL DEFAULT 0,
  protein_g   REAL,
  carbs_g     REAL,
  fat_g       REAL,
  fiber_g     REAL,
  sugar_g     REAL,
  sodium_mg   REAL,
  items_json  TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_food_date ON food_entries(date);

CREATE TABLE exercise_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT,
  duration_min REAL,
  calories     REAL NOT NULL DEFAULT 0,
  details_json TEXT,
  source       TEXT NOT NULL DEFAULT 'manual',
  external_id  TEXT UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_exercise_date ON exercise_entries(date);

CREATE TABLE lab_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  lab_name    TEXT,
  summary     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lab_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL REFERENCES lab_reports(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  panel       TEXT,
  test_name   TEXT NOT NULL,
  test_key    TEXT NOT NULL,
  value       REAL,
  value_text  TEXT,
  unit        TEXT,
  ref_low     REAL,
  ref_high    REAL,
  ref_text    TEXT,
  flag        TEXT
);
CREATE INDEX idx_lab_key_date ON lab_results(test_key, date);

-- Goals. metric is one of: weight_kg, body_fat_pct, muscle_mass_kg, visceral_fat,
-- steps, resting_hr, sleep_minutes, net_calories, protein_g, lab:<test_key>
CREATE TABLE goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  metric       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'target',  -- 'target' (reach a value) | 'daily' (hit every day)
  direction    TEXT NOT NULL DEFAULT 'down',    -- 'down' | 'up'
  start_value  REAL,
  target_value REAL NOT NULL,
  start_date   TEXT NOT NULL,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- active | achieved | archived
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE insights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  content     TEXT NOT NULL
);
