# Health & Fitness tracker

A personal, single-user health and fitness tracker that runs entirely on Cloudflare's **free** tier
(Workers + Static Assets + D1), with Claude doing the reading and estimating.

| What you give it | What happens |
|---|---|
| Fitbit / Google Health export (JSON / CSV from Google Takeout, or a PDF/screenshot report) | Parsed into daily vitals: steps, resting HR, sleep, HRV, SpO₂, calories burned, active minutes, weight |
| Photo of your smart-scale display or app | Claude reads weight, BMI, body fat %, muscle, water, visceral fat, BMR, metabolic age — you review, then save |
| Blood test PDF (or photos of the pages) | Claude extracts every marker with units, reference ranges and H/L flags; markers are trended across reports |
| Food photo and/or description | Claude estimates calories and macros per item — you can edit before saving |
| Workout screenshot / description, or the Fitbod CSV export | Uses the device's calories if shown, otherwise MET-based estimates; Fitbod history imports in one go |
| Goals (weight, body fat, steps, resting HR, protein, any blood marker, …) | Progress %, on-track vs time-based pace, required change per week |
| “Generate review” | Claude reviews 30 days of data, goals and blood work and recalibrates your calorie/protein targets |

Everything is metric. Dates are `YYYY-MM-DD`.

## Architecture

```
Browser (public/: vanilla JS + Chart.js, installable as a PWA)
   │  Bearer APP_TOKEN
   ▼
Cloudflare Worker (src/: Hono)  ──►  D1 (SQLite)  — all your data
   │
   └──►  Claude API (structured outputs) — only for photo/PDF/description extraction and insights
```

Uploaded images and PDFs are **not stored** — only the extracted values. (Storing originals would need R2,
which requires a payment method on file even for the free tier.)

## Deploy to Cloudflare (about 10 minutes)

Prerequisites: Node 20+, a Cloudflare account, and a Claude API key from <https://platform.claude.com>.

```bash
git clone https://github.com/nasirdec/HealthnFitness.git && cd HealthnFitness
npm install
npx wrangler login
```

1. Create the database and paste the printed `database_id` into `wrangler.toml`:

   ```bash
   npx wrangler d1 create healthnfitness
   ```

2. Create the tables:

   ```bash
   npm run db:migrate
   ```

3. Set the two secrets (you'll be prompted for the values). Use a long random string for `APP_TOKEN` —
   it is the password for the app and the API:

   ```bash
   npx wrangler secret put APP_TOKEN
   ```

   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

4. Deploy:

   ```bash
   npm run deploy
   ```

   Wrangler prints your URL, e.g. `https://healthnfitness.<you>.workers.dev`. Open it, enter your `APP_TOKEN`,
   then fill in **Settings** (height, birth year, sex, calorie and protein targets). On a phone, use
   “Add to Home Screen”.

**Recommended:** put the app behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
(free for up to 50 users) so only your Google/email login can even reach the page. If you do, exclude `/api/*`
from Access, or use a [service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/),
so scripts and agents can still post data.

### Run locally

```bash
printf 'APP_TOKEN=dev\nANTHROPIC_API_KEY=sk-ant-...\n' > .dev.vars
npm run db:migrate:local
npm run dev
```

## Getting your data out of Fitbit / Google

* **Fitbit / Google Health history:** <https://takeout.google.com> → select *Fitbit* → export. Unzip, open
  `Fitbit/Global Export Data/` and select the `steps-*.json`, `resting_heart_rate-*.json`, `sleep-*.json`,
  `calories-*.json`, `distance-*.json`, `weight-*.json`, `very_active_minutes-*.json`,
  `moderately_active_minutes-*.json` files, plus any `Daily Heart Rate Variability Summary`, `Daily SpO2`
  and `sleep_score.csv` files. Drop them on **Vitals → Import**. Files the importer doesn't recognise are
  sent to Claude to interpret (up to ~400 KB each).
* **Fitbod:** Fitbod → Settings → *Export workout data* → drop the CSV on **Exercise → Import Fitbod history**.
  One entry per workout day; re-importing skips days already imported.

Google has been migrating Fitbit to Google Health, and the export layout may change. If a file isn't picked
up correctly, send a sample and the parser can be extended.

## Posting data from scripts or Claude (API)

All endpoints need `Authorization: Bearer <APP_TOKEN>`. Add `"save": true` to any `/api/ai/*` call to store the
result directly instead of returning a preview.

```bash
export HF=https://healthnfitness.<you>.workers.dev/api
export HF_TOKEN=...   # your APP_TOKEN
```

Log a meal from a description:

```bash
curl -s "$HF/ai/food" -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"chicken shawarma plate with rice, salad and garlic sauce","date":"2026-11-25","save":true}'
```

Log a scale photo:

```bash
curl -s "$HF/ai/scale" -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"files\":[{\"media_type\":\"image/jpeg\",\"data\":\"$(base64 -w0 scale.jpg)\"}],\"save\":true}"
```

| Method & path | Purpose |
|---|---|
| `GET /api/day/{date}` | Day summary: food, exercise, vitals, body readings, calorie totals vs target |
| `GET /api/trends?days=90&metrics=weight_kg,steps,lab:ldl_cholesterol` | Daily series for charts |
| `GET/POST /api/food`, `PUT/DELETE /api/food/{id}` | Food entries (POST accepts an object or an array) |
| `GET/POST /api/exercise`, `PUT/DELETE /api/exercise/{id}` | Workouts; `external_id` de-duplicates |
| `GET/POST /api/body`, `PUT/DELETE /api/body/{id}` | Scale / body composition readings |
| `GET/POST/DELETE /api/metrics` | Daily tracker metrics, upserted by `(date, metric, source)` |
| `GET/POST /api/labs`, `DELETE /api/labs/{id}`, `GET /api/labs/trend/{test_key}` | Blood test reports and marker trends |
| `GET/POST /api/goals`, `PUT/DELETE /api/goals/{id}` | Goals with computed progress |
| `POST /api/ai/{food,scale,labs,exercise,vitals}` | Claude extraction (`text` and/or `files: [{media_type, data(base64)}]`) |
| `GET/POST /api/insights` | Stored AI reviews / generate a new one |
| `GET /api/export` | Full JSON backup |

## Costs and limits

* **Cloudflare:** the free plan covers a single user comfortably (100k requests/day, 5 GB D1).
  Free Workers get ~10 ms CPU per request; images are resized in the browser to keep uploads small,
  but a very large PDF lab report might occasionally exceed it — split it or upload page photos if so.
* **Claude API:** pay-as-you-go. The model is set by `CLAUDE_MODEL` in `wrangler.toml` (default
  `claude-opus-5-5`, $4 / $20 per million input/output tokens). A food photo is roughly 2–4k tokens, i.e.
  around 3–6 cents each (including thinking); a multi-page lab report is more. Change to `claude-sonnet-5-5` ($2 / $10) or
  `claude-haiku-5-5` ($0.10 / $0.50) to cut costs, at some loss of accuracy on photos and lab reports.
  Requests use server-side refusal fallbacks (`fallbacks: "default"`), so a rare safety decline is retried on
  a fallback model automatically.

## Accuracy notes

* Photo calorie estimates are typically ±20–30 %. Adding a short description (“about 200 g rice, cooked in
  1 tbsp oil”) helps a lot.
* **Avoid double counting exercise.** Fitbit's *calories burned* already includes workouts it detected. The
  Today view shows both views of the day: *Remaining* (target − food + logged exercise) and *Tracker balance*
  (food − Fitbit total burn). If you rely on the Fitbit number, set *Add exercise back to budget* to **No**.
* Blood test extraction should be checked against the PDF before saving. Insights are not medical advice.

## Project layout

```
src/index.ts     API routes (Hono)
src/ai.ts        Claude prompts + Zod schemas for structured extraction
src/goals.ts     Daily series and goal progress
src/db.ts        D1 helpers (bulk inserts within D1's 100-parameter limit)
migrations/      D1 schema
public/          Front end (index.html, app.js, styles.css)
```
