/* Health & Fitness — single-page client. No build step. */
"use strict";

// ------------------------------------------------------------------ utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, d = 0) => (v == null || v === "" || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString("en-CA", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const localDate = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const addDays = (date, n) => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

let TOKEN = null;
try { TOKEN = localStorage.getItem("hf_token"); } catch {}
const state = { date: localDate(), tab: "today", charts: [] };

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`/api${path}${sep}today=${localDate()}`, {
    method: opts.method || "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error("Please sign in again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Run an async action with a busy button and error toast. */
async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.classList.add("spinner"); }
  try { return await fn(); }
  catch (e) { toast(e.message, 6000); console.error(e); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove("spinner"); btn.textContent = label; } }
}

// ------------------------------------------------------------------ files

/** Resize images in the browser (keeps uploads small and Worker CPU low). */
function readImage(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL("image/jpeg", 0.85);
      resolve({ media_type: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl });
    };
    img.onerror = () => reject(new Error(`Can't read image ${file.name}. Try JPEG or PNG.`));
    img.src = url;
  });
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function toAttachments(files) {
  const out = [];
  for (const f of files) {
    if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
      if (f.size > 20 * 1024 * 1024) throw new Error(`${f.name} is larger than 20 MB.`);
      out.push({ media_type: "application/pdf", data: await readBase64(f), name: f.name });
    } else if (f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name)) {
      out.push(await readImage(f));
    } else {
      throw new Error(`${f.name}: unsupported file type`);
    }
  }
  return out;
}

/** Drop zone + file input. Returns a getter for the selected File objects. */
function dropZone(el, { accept, multiple = true, label }) {
  el.innerHTML = `<div class="drop">${esc(label)}<br><input type="file" ${multiple ? "multiple" : ""} accept="${accept}" /><div class="thumbs"></div></div>`;
  const drop = $(".drop", el), input = $("input", el), thumbs = $(".thumbs", el);
  let files = [];
  const show = () => {
    thumbs.innerHTML = "";
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(f);
        thumbs.append(img);
      } else {
        const s = document.createElement("span");
        s.className = "pill";
        s.textContent = f.name;
        thumbs.append(s);
      }
    }
  };
  input.addEventListener("change", () => { files = [...input.files]; show(); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); files = [...e.dataTransfer.files]; show(); });
  return { get: () => files, clear: () => { files = []; input.value = ""; show(); } };
}

// ------------------------------------------------------------------ auth / nav

function logout() {
  TOKEN = null;
  try { localStorage.removeItem("hf_token"); } catch {}
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  TOKEN = $("#login-token").value.trim();
  try {
    await api("/settings");
    try { localStorage.setItem("hf_token", TOKEN); } catch {}
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
    $("#login").classList.remove("hidden");
  }
});

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  location.hash = state.tab;
  render();
});

function start() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  const h = location.hash.slice(1);
  if (VIEWS[h]) state.tab = h;
  render();
}

function render() {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  const view = $("#view");
  view.innerHTML = `<p class="muted">Loading…</p>`;
  VIEWS[state.tab](view).catch((e) => { view.innerHTML = `<div class="card error">${esc(e.message)}</div>`; });
}

function dateBar(onChange) {
  return `<div class="row">
    <button class="small" data-shift="-1">◀</button>
    <input type="date" id="day" value="${state.date}" style="width:auto" />
    <button class="small" data-shift="1">▶</button>
    <button class="small" data-shift="0">Today</button>
  </div>`;
}
function wireDateBar(root) {
  $$("[data-shift]", root).forEach((b) => b.addEventListener("click", () => {
    const n = Number(b.dataset.shift);
    state.date = n === 0 ? localDate() : addDays(state.date, n);
    render();
  }));
  $("#day", root)?.addEventListener("change", (e) => { state.date = e.target.value; render(); });
}

// ------------------------------------------------------------------ charts

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
const SERIES_COLORS = ["#0f766e", "#2563eb", "#d97706", "#9333ea", "#dc2626"];

function lineChart(canvas, datasets, { type = "line", yLabel = "" } = {}) {
  if (!window.Chart) return;
  const grid = cssVar("--border"), text = cssVar("--muted");
  const chart = new Chart(canvas, {
    type,
    data: {
      datasets: datasets.map((d, i) => ({
        label: d.label,
        data: d.data.map((p) => ({ x: p.date, y: p.value })),
        borderColor: d.color || SERIES_COLORS[i % SERIES_COLORS.length],
        backgroundColor: (d.color || SERIES_COLORS[i % SERIES_COLORS.length]) + (type === "bar" ? "cc" : "33"),
        tension: 0.25, pointRadius: 2, spanGaps: true, borderWidth: 2,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, parsing: { xAxisKey: "x", yAxisKey: "y" },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: text, boxWidth: 12 } } },
      scales: {
        x: { type: "category", ticks: { color: text, maxTicksLimit: 8 }, grid: { color: grid } },
        y: { ticks: { color: text }, grid: { color: grid }, title: { display: !!yLabel, text: yLabel, color: text } },
      },
    },
  });
  state.charts.push(chart);
}

// Merge series onto one shared date axis so Chart.js category axes line up
function alignSeries(seriesList) {
  const dates = [...new Set(seriesList.flatMap((s) => s.data.map((p) => p.date)))].sort();
  return seriesList.map((s) => {
    const m = new Map(s.data.map((p) => [p.date, p.value]));
    return { ...s, data: dates.map((d) => ({ date: d, value: m.has(d) ? m.get(d) : null })) };
  });
}

// ------------------------------------------------------------------ views
const METRIC_LABELS = {
  weight_kg: "Weight (kg)", body_fat_pct: "Body fat %", muscle_mass_kg: "Muscle mass (kg)", visceral_fat: "Visceral fat",
  water_pct: "Body water %", bmi: "BMI", skeletal_muscle_pct: "Skeletal muscle %",
  steps: "Steps", resting_hr: "Resting HR (bpm)", sleep_minutes: "Sleep (min)", active_minutes: "Active minutes",
  hrv_ms: "HRV (ms)", calories_out: "Calories burned (tracker)", active_zone_minutes: "Active zone minutes",
  net_calories: "Net calories (food − exercise)", calories_in: "Calories eaten", protein_g: "Protein (g)",
  exercise_calories: "Exercise calories", spo2_pct: "SpO₂ %", sleep_score: "Sleep score", distance_km: "Distance (km)",
  breathing_rate: "Breathing rate", floors: "Floors", vo2max: "VO₂ max",
};
const label = (m) => METRIC_LABELS[m] || (m.startsWith("lab:") ? `Lab: ${m.slice(4)}` : m);

const VIEWS = {
  // ---------------------------------------------------------------- Today
  async today(view) {
    const [day, goals] = await Promise.all([api(`/day/${state.date}`), api("/goals")]);
    const t = day.totals;
    const m = Object.fromEntries(day.metrics.map((x) => [x.metric, x.value]));
    const latestBody = day.body[day.body.length - 1];
    view.innerHTML = `
      <div class="row between"><h2>Daily summary</h2>${dateBar()}</div>
      <div class="grid">
        ${stat("Eaten", fmt(t.calories_in), "kcal")}
        ${stat("Exercise", fmt(t.exercise_calories), "kcal burned")}
        ${stat("Net", fmt(t.net_calories), "kcal")}
        ${stat("Remaining", t.remaining == null ? "—" : fmt(t.remaining), t.calorie_target ? `of ${fmt(t.calorie_target)} target` : "set a target in Settings", t.remaining != null && t.remaining < 0 ? "bad" : "")}
        ${stat("Protein", fmt(t.protein_g) + " g", t.protein_target ? `target ${t.protein_target} g` : `C ${fmt(t.carbs_g)} · F ${fmt(t.fat_g)} g`)}
        ${t.tracker_calories_out != null ? stat("Tracker burn", fmt(t.tracker_calories_out), `balance ${t.tracker_balance > 0 ? "+" : ""}${fmt(t.tracker_balance)} kcal`, t.tracker_balance > 0 ? "warn" : "good") : ""}
      </div>
      <div class="grid">
        ${stat("Steps", fmt(m.steps))}
        ${stat("Resting HR", fmt(m.resting_hr), "bpm")}
        ${stat("Sleep", m.sleep_minutes ? `${Math.floor(m.sleep_minutes / 60)}h ${Math.round(m.sleep_minutes % 60)}m` : "—")}
        ${stat("Weight", latestBody?.weight_kg ? fmt(latestBody.weight_kg, 1) + " kg" : m.weight_kg ? fmt(m.weight_kg, 1) + " kg" : "—", latestBody?.body_fat_pct ? `${fmt(latestBody.body_fat_pct, 1)} % fat` : "")}
        ${m.hrv_ms ? stat("HRV", fmt(m.hrv_ms), "ms") : ""}
      </div>
      <div class="grid wide">
        <div class="card"><div class="row between"><h3>Food</h3><button class="small" data-go="food">+ Add</button></div>${foodTable(day.food)}</div>
        <div class="card"><div class="row between"><h3>Exercise</h3><button class="small" data-go="exercise">+ Add</button></div>${exerciseTable(day.exercise)}</div>
      </div>
      <div class="card"><div class="row between"><h3>Goals</h3><button class="small" data-go="goals">Manage</button></div>${goalsList(goals, true)}</div>`;
    wireDateBar(view);
    wireDeletes(view);
    $$("[data-go]", view).forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.go; render(); }));
  },

  // ---------------------------------------------------------------- Food
  async food(view) {
    const day = await api(`/day/${state.date}`);
    view.innerHTML = `
      <div class="row between"><h2>Food log</h2>${dateBar()}</div>
      <div class="card stack">
        <h3>Snap or describe what you ate</h3>
        <div id="food-drop"></div>
        <textarea id="food-text" placeholder="e.g. 2 scrambled eggs with butter, 1 slice sourdough toast, black coffee"></textarea>
        <div class="row"><button class="primary" id="food-estimate">Estimate calories</button>
        <span class="muted">Claude estimates; you review before saving.</span></div>
        <div id="food-preview"></div>
      </div>
      <div class="card"><h3>${esc(state.date)} — ${fmt(day.totals.calories_in)} kcal · P ${fmt(day.totals.protein_g)} g · C ${fmt(day.totals.carbs_g)} g · F ${fmt(day.totals.fat_g)} g</h3>${foodTable(day.food)}</div>
      <details class="card"><summary>Manual entry</summary>${foodForm({ description: "", meal: guessMeal() })}</details>`;
    wireDateBar(view);
    wireDeletes(view);
    const dz = dropZone($("#food-drop", view), { accept: "image/*", label: "Food photo(s) — optional" });
    wireFoodForm($("details form", view));
    $("#food-estimate", view).addEventListener("click", (e) => busy(e.target, async () => {
      const files = await toAttachments(dz.get());
      const text = $("#food-text", view).value.trim();
      const est = await api("/ai/food", { method: "POST", body: { text, files } });
      const p = $("#food-preview", view);
      p.innerHTML = `
        <div class="table-wrap"><table><tr><th>Item</th><th>Portion</th><th class="num">kcal</th><th class="num">P</th><th class="num">C</th><th class="num">F</th></tr>
        ${est.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.portion)}</td><td class="num">${fmt(i.calories)}</td><td class="num">${fmt(i.protein_g)}</td><td class="num">${fmt(i.carbs_g)}</td><td class="num">${fmt(i.fat_g)}</td></tr>`).join("")}
        </table></div>
        <p class="muted">Confidence: ${esc(est.confidence)}. ${esc(est.notes)}</p>
        ${foodForm({ ...est.total, description: est.description, meal: est.meal || guessMeal(), items_json: JSON.stringify(est.items), source: files.length ? "ai-photo" : "ai-text" })}`;
      wireFoodForm($("form", p), () => { dz.clear(); $("#food-text", view).value = ""; });
    }));
  },

  // ---------------------------------------------------------------- Exercise
  async exercise(view) {
    const day = await api(`/day/${state.date}`);
    view.innerHTML = `
      <div class="row between"><h2>Exercise</h2>${dateBar()}</div>
      <div class="card stack">
        <h3>Screenshot or describe a workout</h3>
        <div id="ex-drop"></div>
        <textarea id="ex-text" placeholder="e.g. 45 min Fitbod upper body: bench 4x8 @ 60 kg, rows 4x10 @ 50 kg… or '30 min brisk walk'"></textarea>
        <div class="row"><button class="primary" id="ex-estimate">Calculate calories</button>
        <span class="muted">Uses the device's calories if visible, otherwise MET estimates.</span></div>
        <div id="ex-preview"></div>
      </div>
      <div class="card"><h3>${esc(state.date)} — ${fmt(day.totals.exercise_calories)} kcal</h3>${exerciseTable(day.exercise)}</div>
      <div class="card stack">
        <h3>Import Fitbod history (CSV)</h3>
        <p class="muted">Fitbod → Settings → Export workout data. Re-importing is safe (one entry per workout day; duplicates are skipped).</p>
        <div id="fitbod-drop"></div>
        <button id="fitbod-import">Import</button>
        <p id="fitbod-result" class="muted"></p>
      </div>
      <details class="card"><summary>Manual entry</summary>${exerciseForm({})}</details>`;
    wireDateBar(view);
    wireDeletes(view);
    wireExerciseForm($("details form", view));
    const dz = dropZone($("#ex-drop", view), { accept: "image/*", label: "Workout screenshot(s) — optional" });
    $("#ex-estimate", view).addEventListener("click", (e) => busy(e.target, async () => {
      const files = await toAttachments(dz.get());
      const r = await api("/ai/exercise", { method: "POST", body: { text: $("#ex-text", view).value.trim(), files } });
      const p = $("#ex-preview", view);
      p.innerHTML = `<p class="muted">${esc(r.notes)}</p>` + r.activities.map((a) =>
        exerciseForm({ ...a, date: a.date || state.date, details_json: JSON.stringify({ details: a.details, calories_source: a.calories_source }) }, `${a.calories_source === "device" ? "From device" : "Estimated"} — ${esc(a.details)}`)).join("");
      $$("form", p).forEach((f) => wireExerciseForm(f, () => f.remove()));
    }));
    const fb = dropZone($("#fitbod-drop", view), { accept: ".csv,text/csv", multiple: false, label: "Fitbod CSV export" });
    $("#fitbod-import", view).addEventListener("click", (e) => busy(e.target, async () => {
      const f = fb.get()[0];
      if (!f) throw new Error("Choose the Fitbod CSV first.");
      const trends = await api("/trends?metrics=weight_kg&days=3650");
      const w = trends.weight_kg.length ? trends.weight_kg[trends.weight_kg.length - 1].value : 80;
      const workouts = parseFitbod(await f.text(), w);
      let inserted = 0;
      for (let i = 0; i < workouts.length; i += 400) {
        inserted += (await api("/exercise", { method: "POST", body: workouts.slice(i, i + 400) })).inserted;
      }
      $("#fitbod-result", view).textContent = `Parsed ${workouts.length} workout days; ${inserted} new saved (estimates use ${fmt(w, 1)} kg body weight).`;
    }));
  },

  // ---------------------------------------------------------------- Body
  async body(view) {
    const rows = await api(`/body?from=2000-01-01&to=${localDate()}`);
    view.innerHTML = `
      <h2>Weight &amp; body composition</h2>
      <div class="card stack">
        <h3>Scale photo</h3>
        <div id="scale-drop"></div>
        <button class="primary" id="scale-extract">Read values</button>
        <div id="scale-preview"></div>
      </div>
      <details class="card"><summary>Manual entry</summary>${bodyForm({ date: localDate(), time: nowTime() })}</details>
      <div class="card"><div class="chart-box"><canvas id="body-chart"></canvas></div></div>
      <div class="card table-wrap"><table>
        <tr><th>Date</th><th class="num">Weight</th><th class="num">BMI</th><th class="num">Fat %</th><th class="num">Muscle kg</th><th class="num">Water %</th><th class="num">Visceral</th><th class="num">BMR</th><th></th></tr>
        ${rows.map((r) => `<tr><td>${esc(r.date)} ${esc(r.time || "")}</td><td class="num">${fmt(r.weight_kg, 1)}</td><td class="num">${fmt(r.bmi, 1)}</td><td class="num">${fmt(r.body_fat_pct, 1)}</td><td class="num">${fmt(r.muscle_mass_kg, 1)}</td><td class="num">${fmt(r.water_pct, 1)}</td><td class="num">${fmt(r.visceral_fat, 1)}</td><td class="num">${fmt(r.bmr_kcal)}</td><td><button class="link" data-del="/body/${r.id}">✕</button></td></tr>`).join("") || `<tr><td colspan="9" class="muted">No readings yet.</td></tr>`}
      </table></div>`;
    wireDeletes(view);
    wireBodyForm($("details form", view));
    const asc = [...rows].reverse();
    lineChart($("#body-chart", view), alignSeries([
      { label: "Weight (kg)", data: asc.filter((r) => r.weight_kg).map((r) => ({ date: r.date, value: r.weight_kg })) },
      { label: "Body fat %", data: asc.filter((r) => r.body_fat_pct).map((r) => ({ date: r.date, value: r.body_fat_pct })) },
    ]));
    const dz = dropZone($("#scale-drop", view), { accept: "image/*", multiple: true, label: "Photo of the scale display or app screenshot" });
    $("#scale-extract", view).addEventListener("click", (e) => busy(e.target, async () => {
      const files = await toAttachments(dz.get());
      if (!files.length) throw new Error("Add a photo first.");
      const r = await api("/ai/scale", { method: "POST", body: { files } });
      const p = $("#scale-preview", view);
      p.innerHTML = `<p class="muted">${esc(r.notes)}</p>${bodyForm({ ...r, date: r.date || localDate(), time: r.time || nowTime(), source: "ai-scale", extra_json: JSON.stringify(r.other) })}`;
      wireBodyForm($("form", p), () => dz.clear());
    }));
  },

  // ---------------------------------------------------------------- Vitals
  async vitals(view) {
    const recent = await api(`/metrics?from=${addDays(localDate(), -13)}&to=${localDate()}`);
    const byDate = {};
    for (const r of recent) (byDate[r.date] ||= {})[r.metric] = r.value;
    const metricCols = ["steps", "resting_hr", "sleep_minutes", "calories_out", "active_minutes", "hrv_ms", "spo2_pct"];
    view.innerHTML = `
      <h2>Vitals (Fitbit / Google Health)</h2>
      <div class="card stack">
        <h3>Import export files</h3>
        <p class="muted">Supports a Google Takeout Fitbit export (select the files inside <code>Fitbit/Global Export Data</code> and any
        <code>Daily … Summary</code> CSVs), plain CSVs with a date column, or a PDF/screenshot report (read by Claude).
        Re-importing overwrites the same day/metric, so it's safe to repeat.</p>
        <div id="vit-drop"></div>
        <label class="row" style="color:var(--text)"><input type="checkbox" id="vit-lbs" style="width:auto" /> Weight in the export is in pounds</label>
        <button class="primary" id="vit-import">Import</button>
        <pre id="vit-log" class="muted" style="white-space:pre-wrap"></pre>
      </div>
      <div class="card table-wrap"><h3>Last 14 days</h3><table>
        <tr><th>Date</th>${metricCols.map((m) => `<th class="num">${esc(label(m))}</th>`).join("")}</tr>
        ${Object.keys(byDate).sort().reverse().map((d) => `<tr><td>${d}</td>${metricCols.map((m) => `<td class="num">${fmt(byDate[d][m], m === "spo2_pct" ? 1 : 0)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="8" class="muted">No data yet.</td></tr>`}
      </table></div>
      <details class="card"><summary>Manual entry</summary>
        <form class="form-grid" id="vit-form">
          <label>Date<input name="date" type="date" value="${localDate()}" required></label>
          <label>Metric<select name="metric">${["steps", "resting_hr", "sleep_minutes", "calories_out", "active_minutes", "hrv_ms", "spo2_pct", "vo2max"].map((m) => `<option value="${m}">${esc(label(m))}</option>`).join("")}</select></label>
          <label>Value<input name="value" type="number" step="any" required></label>
          <div class="row" style="align-items:end"><button class="primary">Save</button></div>
        </form>
      </details>`;
    $("#vit-form", view).addEventListener("submit", (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const f = Object.fromEntries(new FormData(e.target));
      await api("/metrics", { method: "POST", body: [{ ...f, value: Number(f.value), source: "manual" }] });
      toast("Saved"); render();
    }); });
    const dz = dropZone($("#vit-drop", view), { accept: ".json,.csv,.pdf,image/*", label: "Drop Fitbit / Google Health files here" });
    $("#vit-import", view).addEventListener("click", (e) => busy(e.target, async () => {
      const files = dz.get();
      if (!files.length) throw new Error("Choose files first.");
      const log = $("#vit-log", view);
      log.textContent = "";
      const lbs = $("#vit-lbs", view).checked;
      const rows = [], aiFiles = [], aiTexts = [];
      for (const f of files) {
        if (/\.(pdf|jpe?g|png|webp|heic)$/i.test(f.name)) { aiFiles.push(f); continue; }
        const text = await f.text();
        const parsed = parseHealthFile(f.name, text, { lbs });
        if (parsed) { rows.push(...parsed); log.textContent += `${f.name}: ${parsed.length} values\n`; }
        else { aiTexts.push({ name: f.name, text }); log.textContent += `${f.name}: unrecognised format → Claude\n`; }
      }
      const merged = mergeMetricRows(rows);
      for (let i = 0; i < merged.length; i += 500) {
        await api("/metrics", { method: "POST", body: merged.slice(i, i + 500) });
        log.textContent += `Uploaded ${Math.min(i + 500, merged.length)}/${merged.length}\n`;
      }
      for (const t of aiTexts) {
        if (t.text.length > 400000) { log.textContent += `${t.name}: too large for AI parsing, skipped\n`; continue; }
        const r = await api("/ai/vitals", { method: "POST", body: { text: `File: ${t.name}\n${t.text}`, save: true } });
        log.textContent += `${t.name}: Claude imported ${r.upserted} values. ${r.notes}\n`;
      }
      if (aiFiles.length) {
        const r = await api("/ai/vitals", { method: "POST", body: { files: await toAttachments(aiFiles), save: true } });
        log.textContent += `Report(s): Claude imported ${r.upserted} values. ${r.notes}\n`;
      }
      toast("Import complete");
    }));
  },

  // ---------------------------------------------------------------- Labs
  async labs(view) {
    const reports = await api("/labs");
    const keys = {};
    for (const r of reports) for (const x of r.results) if (x.value != null) (keys[x.test_key] ||= x.test_name);
    view.innerHTML = `
      <h2>Blood tests</h2>
      <div class="card stack">
        <h3>Upload a lab report</h3>
        <div id="lab-drop"></div>
        <button class="primary" id="lab-extract">Extract results</button>
        <p class="muted">One report per extraction. Large PDFs can take ~30–60 s.</p>
        <div id="lab-preview"></div>
      </div>
      <div class="card"><h3>Trend</h3>
        <select id="lab-key"><option value="">Choose a marker…</option>${Object.entries(keys).sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join("")}</select>
        <div class="chart-box" style="margin-top:8px"><canvas id="lab-chart"></canvas></div>
      </div>
      ${reports.map((r) => `
        <div class="card"><div class="row between"><h3>${esc(r.date)} ${r.lab_name ? "· " + esc(r.lab_name) : ""}</h3><button class="link" data-del="/labs/${r.id}">Delete</button></div>
        ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}
        <details ${r === reports[0] ? "open" : ""}><summary>${r.results.length} results · ${r.results.filter((x) => ["high", "low", "abnormal"].includes(x.flag)).length} flagged</summary>${labTable(r.results)}</details></div>`).join("") || `<p class="muted">No reports yet.</p>`}`;
    wireDeletes(view, "Delete this report and all its results?");
    $("#lab-key", view).addEventListener("change", async (e) => {
      if (!e.target.value) return;
      const s = await api(`/labs/trend/${encodeURIComponent(e.target.value)}`);
      state.charts.forEach((c) => c.destroy()); state.charts = [];
      const last = s[s.length - 1] || {};
      const ds = [{ label: `${keys[e.target.value]} (${last.unit || ""})`, data: s.map((p) => ({ date: p.date, value: p.value })) }];
      if (last.ref_low != null) ds.push({ label: "Ref low", color: "#9ca3af", data: s.map((p) => ({ date: p.date, value: p.ref_low ?? last.ref_low })) });
      if (last.ref_high != null) ds.push({ label: "Ref high", color: "#9ca3af", data: s.map((p) => ({ date: p.date, value: p.ref_high ?? last.ref_high })) });
      lineChart($("#lab-chart", view), ds);
    });
    const dz = dropZone($("#lab-drop", view), { accept: "application/pdf,image/*", label: "Lab report PDF (or photos of each page)" });
    $("#lab-extract", view).addEventListener("click", (e) => busy(e.target, async () => {
      const files = await toAttachments(dz.get());
      if (!files.length) throw new Error("Add the report first.");
      const r = await api("/ai/labs", { method: "POST", body: { files } });
      const p = $("#lab-preview", view);
      p.innerHTML = `
        <div class="form-grid"><label>Report date<input id="lab-date" type="date" value="${esc(r.report_date || "")}" required></label>
        <label>Lab<input id="lab-name" value="${esc(r.lab_name || "")}"></label></div>
        <p>${esc(r.summary)}</p>${labTable(r.results)}
        <div class="row"><button class="primary" id="lab-save">Save report (${r.results.length} results)</button><span class="muted">Check the values against the PDF before saving.</span></div>`;
      $("#lab-save", p).addEventListener("click", (ev) => busy(ev.target, async () => {
        const date = $("#lab-date", p).value;
        if (!date) throw new Error("Report date is required.");
        await api("/labs", { method: "POST", body: { ...r, date, lab_name: $("#lab-name", p).value } });
        toast("Report saved"); render();
      }));
    }));
  },

  // ---------------------------------------------------------------- Goals
  async goals(view) {
    const [goals, reports] = await Promise.all([api("/goals"), api("/labs")]);
    const labKeys = {};
    for (const r of reports) for (const x of r.results) if (x.value != null) labKeys[x.test_key] ||= x.test_name;
    const metricOpts = ["weight_kg", "body_fat_pct", "muscle_mass_kg", "visceral_fat", "steps", "resting_hr", "sleep_minutes", "active_minutes", "hrv_ms", "net_calories", "calories_in", "protein_g", "exercise_calories"];
    view.innerHTML = `
      <h2>Goals</h2>
      <div class="card">${goalsList(goals, false)}</div>
      <div class="card"><h3>New goal</h3>
        <form id="goal-form" class="form-grid">
          <label>Title<input name="title" required placeholder="Lose 8 kg by summer"></label>
          <label>Metric<select name="metric">
            ${metricOpts.map((m) => `<option value="${m}">${esc(label(m))}</option>`).join("")}
            ${Object.entries(labKeys).map(([k, n]) => `<option value="lab:${esc(k)}">Blood: ${esc(n)}</option>`).join("")}
          </select></label>
          <label>Type<select name="kind"><option value="target">Reach a value</option><option value="daily">Hit daily (7-day %)</option></select></label>
          <label>Direction<select name="direction"><option value="">Auto</option><option value="down">Lower is better</option><option value="up">Higher is better</option></select></label>
          <label>Target value<input name="target_value" type="number" step="any" required></label>
          <label>Start value (blank = current)<input name="start_value" type="number" step="any"></label>
          <label>Target date<input name="target_date" type="date"></label>
          <div class="row" style="align-items:end"><button class="primary">Add goal</button></div>
        </form>
        <p class="muted">Tip: a safe fat-loss pace is roughly 0.5–1 % of body weight per week.</p>
      </div>`;
    wireDeletes(view, "Delete this goal?");
    $$("[data-goal-status]", view).forEach((b) => b.addEventListener("click", () => busy(b, async () => {
      await api(`/goals/${b.dataset.id}`, { method: "PUT", body: { status: b.dataset.goalStatus } }); render();
    })));
    $("#goal-form", view).addEventListener("submit", (e) => { e.preventDefault(); busy(e.submitter, async () => {
      const f = Object.fromEntries(new FormData(e.target));
      const body = { title: f.title, metric: f.metric, kind: f.kind, target_value: Number(f.target_value) };
      if (f.direction) body.direction = f.direction;
      if (f.start_value) body.start_value = Number(f.start_value);
      if (f.target_date) body.target_date = f.target_date;
      await api("/goals", { method: "POST", body });
      toast("Goal added"); render();
    }); });
  },

  // ---------------------------------------------------------------- Trends
  async trends(view) {
    const days = Number(state.trendDays || 90);
    const d = await api(`/trends?days=${days}&metrics=weight_kg,body_fat_pct,calories_in,exercise_calories,net_calories,steps,resting_hr,sleep_minutes,hrv_ms,calories_out,protein_g`);
    const s = await api("/settings");
    view.innerHTML = `
      <div class="row between"><h2>Trends</h2>
        <select id="trend-days" style="width:auto">${[30, 90, 180, 365, 730].map((n) => `<option value="${n}" ${n === days ? "selected" : ""}>Last ${n} days</option>`).join("")}</select></div>
      <div class="grid wide">
        <div class="card"><h3>Weight &amp; body fat</h3><div class="chart-box"><canvas id="c1"></canvas></div></div>
        <div class="card"><h3>Calories</h3><div class="chart-box"><canvas id="c2"></canvas></div></div>
        <div class="card"><h3>Steps</h3><div class="chart-box"><canvas id="c3"></canvas></div></div>
        <div class="card"><h3>Resting HR &amp; HRV</h3><div class="chart-box"><canvas id="c4"></canvas></div></div>
        <div class="card"><h3>Sleep (hours)</h3><div class="chart-box"><canvas id="c5"></canvas></div></div>
        <div class="card"><h3>Protein (g)</h3><div class="chart-box"><canvas id="c6"></canvas></div></div>
      </div>`;
    $("#trend-days", view).addEventListener("change", (e) => { state.trendDays = e.target.value; render(); });
    lineChart($("#c1", view), alignSeries([{ label: "Weight (kg)", data: d.weight_kg }, { label: "Body fat %", data: d.body_fat_pct }]));
    const calSeries = [{ label: "Eaten", data: d.calories_in }, { label: "Exercise", data: d.exercise_calories }, { label: "Net", data: d.net_calories }];
    if (d.calories_out.length) calSeries.push({ label: "Tracker burn", data: d.calories_out });
    if (s.calorie_target) calSeries.push({ label: "Target", color: "#9ca3af", data: d.calories_in.map((p) => ({ date: p.date, value: Number(s.calorie_target) })) });
    lineChart($("#c2", view), alignSeries(calSeries));
    lineChart($("#c3", view), [{ label: "Steps", data: d.steps }], { type: "bar" });
    lineChart($("#c4", view), alignSeries([{ label: "Resting HR", data: d.resting_hr }, { label: "HRV (ms)", data: d.hrv_ms }]));
    lineChart($("#c5", view), [{ label: "Sleep", data: d.sleep_minutes.map((p) => ({ date: p.date, value: +(p.value / 60).toFixed(2) })) }], { type: "bar" });
    lineChart($("#c6", view), [{ label: "Protein", data: d.protein_g }], { type: "bar" });
  },

  // ---------------------------------------------------------------- Insights
  async insights(view) {
    const list = await api("/insights");
    view.innerHTML = `
      <div class="row between"><h2>Insights</h2><button class="primary" id="gen">Generate new review</button></div>
      <p class="muted">Claude reviews your last 30 days, goals and blood work and recalibrates your targets. Not medical advice.</p>
      <div id="ins">${list.map((i) => `<div class="card"><p class="muted">${esc(i.created_at)} UTC</p><div class="md">${md(i.content)}</div></div>`).join("") || `<p class="muted">No reviews yet.</p>`}</div>`;
    $("#gen", view).addEventListener("click", (e) => busy(e.target, async () => {
      await api("/insights", { method: "POST" });
      render();
    }));
  },

  // ---------------------------------------------------------------- Settings
  async settings(view) {
    const [s, health] = await Promise.all([api("/settings"), fetch("/api/health").then((r) => r.json())]);
    view.innerHTML = `
      <h2>Settings</h2>
      <div class="card"><h3>Profile &amp; targets</h3>
        <form id="set-form" class="form-grid">
          <label>Height (cm)<input name="height_cm" type="number" step="any" value="${esc(s.height_cm)}"></label>
          <label>Birth year<input name="birth_year" type="number" value="${esc(s.birth_year)}"></label>
          <label>Sex (for BMR)<select name="sex"><option value="male" ${s.sex === "male" ? "selected" : ""}>Male</option><option value="female" ${s.sex === "female" ? "selected" : ""}>Female</option></select></label>
          <label>Daily calorie target (kcal)<input name="calorie_target" type="number" value="${esc(s.calorie_target)}"></label>
          <label>Daily protein target (g)<input name="protein_target" type="number" value="${esc(s.protein_target)}"></label>
          <label>Add exercise back to budget<select name="eat_back_exercise"><option value="true" ${s.eat_back_exercise !== "false" ? "selected" : ""}>Yes</option><option value="false" ${s.eat_back_exercise === "false" ? "selected" : ""}>No</option></select></label>
          <div class="row" style="align-items:end"><button class="primary">Save</button></div>
        </form>
        <p class="muted" id="bmr-hint"></p>
      </div>
      <div class="card stack"><h3>System</h3>
        <p>AI extraction: ${health.ai ? `<span class="good">enabled</span> (${esc(health.model)})` : `<span class="bad">not configured</span> — set the ANTHROPIC_API_KEY secret`}</p>
        <div class="row">
          <button id="export">Download backup (JSON)</button>
          <button id="theme">Toggle theme</button>
          <button id="logout">Sign out</button>
        </div>
      </div>`;
    const day = await api(`/day/${localDate()}`);
    if (day.totals.bmr) {
      $("#bmr-hint", view).textContent = `Estimated BMR ${fmt(day.totals.bmr)} kcal/day. Sedentary maintenance ≈ ${fmt(day.totals.bmr * 1.2)} kcal; a 500 kcal deficit ≈ ${fmt(day.totals.bmr * 1.2 - 500)} kcal (plus exercise if “add back” is on).`;
    }
    $("#set-form", view).addEventListener("submit", (e) => { e.preventDefault(); busy(e.submitter, async () => {
      await api("/settings", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) });
      toast("Saved"); render();
    }); });
    $("#export", view).addEventListener("click", (e) => busy(e.target, async () => {
      const data = await api("/export");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      a.download = `health-backup-${localDate()}.json`;
      a.click();
    }));
    $("#theme", view).addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
      try { localStorage.setItem("hf_theme", document.documentElement.dataset.theme); } catch {}
    });
    $("#logout", view).addEventListener("click", logout);
  },
};

// ------------------------------------------------------------------ components

function stat(lbl, value, sub = "", cls = "") {
  return `<div class="card stat"><div class="label">${esc(lbl)}</div><div class="value ${cls}">${value}</div><div class="sub">${esc(sub)}</div></div>`;
}

function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  return `<pre style="white-space:pre-wrap">${esc(text)}</pre>`;
}

function guessMeal() {
  const h = new Date().getHours();
  return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 21 ? "dinner" : "snack";
}

function foodTable(rows) {
  if (!rows.length) return `<p class="muted">Nothing logged.</p>`;
  return `<div class="table-wrap"><table><tr><th>Meal</th><th>What</th><th class="num">kcal</th><th class="num">P</th><th class="num">C</th><th class="num">F</th><th></th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.meal || "")}<br><span class="muted">${esc(r.time || "")}</span></td><td>${esc(r.description)}</td><td class="num">${fmt(r.calories)}</td><td class="num">${fmt(r.protein_g)}</td><td class="num">${fmt(r.carbs_g)}</td><td class="num">${fmt(r.fat_g)}</td><td><button class="link" data-del="/food/${r.id}">✕</button></td></tr>`).join("")}
  </table></div>`;
}

function exerciseTable(rows) {
  if (!rows.length) return `<p class="muted">Nothing logged.</p>`;
  return `<div class="table-wrap"><table><tr><th>Activity</th><th class="num">Min</th><th class="num">kcal</th><th></th></tr>
    ${rows.map((r) => {
      let det = "";
      try { const d = JSON.parse(r.details_json || "{}"); det = d.details || d.summary || ""; } catch {}
      return `<tr><td>${esc(r.name)}<br><span class="muted">${esc(det).slice(0, 160)}</span></td><td class="num">${fmt(r.duration_min)}</td><td class="num">${fmt(r.calories)}</td><td><button class="link" data-del="/exercise/${r.id}">✕</button></td></tr>`;
    }).join("")}
  </table></div>`;
}

function labTable(results) {
  return `<div class="table-wrap"><table><tr><th>Test</th><th class="num">Value</th><th>Unit</th><th>Reference</th><th>Flag</th></tr>
    ${results.map((x) => `<tr><td>${esc(x.test_name)}${x.panel ? `<br><span class="muted">${esc(x.panel)}</span>` : ""}</td>
      <td class="num">${x.value != null ? fmt(x.value, 2) : esc(x.value_text)}</td><td>${esc(x.unit)}</td>
      <td>${x.ref_text ? esc(x.ref_text) : x.ref_low != null || x.ref_high != null ? `${x.ref_low ?? ""}–${x.ref_high ?? ""}` : ""}</td>
      <td><span class="pill ${esc(x.flag)}">${esc(x.flag)}</span></td></tr>`).join("")}
  </table></div>`;
}

function goalsList(goals, compact) {
  if (!goals.length) return `<p class="muted">No goals yet.</p>`;
  return goals.map((g) => {
    const unitDp = /weight|kg|pct|fat/.test(g.metric) ? 1 : 0;
    let line;
    if (g.kind === "daily") {
      line = `Hit ${g.days_hit_last_7 ?? 0}/7 days (target ${g.direction === "down" ? "≤" : "≥"} ${fmt(g.target_value, unitDp)})`;
    } else {
      line = `Now ${fmt(g.current, unitDp)} → target ${fmt(g.target_value, unitDp)} (start ${fmt(g.start_value, unitDp)})`;
      if (g.target_date) line += ` · ${g.days_left} days left`;
      if (g.required_per_week != null) line += ` · need ${g.required_per_week > 0 ? "+" : ""}${fmt(g.required_per_week, 2)}/week`;
    }
    const track = g.status === "achieved" ? `<span class="good">Achieved</span>` : g.on_track == null ? "" : g.on_track ? `<span class="good">On track</span>` : `<span class="warn">Behind</span>`;
    return `<div class="stack" style="margin-bottom:14px">
      <div class="row between"><strong>${esc(g.title)}</strong><span>${track} ${fmt(g.progress_pct)}%</span></div>
      <div class="bar"><span style="width:${g.progress_pct || 0}%"></span>${g.expected_pct != null ? `<i style="left:${g.expected_pct}%" title="Where you should be by now"></i>` : ""}</div>
      <div class="row between"><span class="muted">${esc(label(g.metric))} · ${line}</span>
      ${compact ? "" : `<span>${g.status === "active" ? `<button class="small" data-goal-status="achieved" data-id="${g.id}">Mark achieved</button>` : ""}
        <button class="small" data-goal-status="archived" data-id="${g.id}">Archive</button>
        <button class="link" data-del="/goals/${g.id}">✕</button></span>`}</div></div>`;
  }).join("");
}

function wireDeletes(root, confirmMsg = "Delete this entry?") {
  $$("[data-del]", root).forEach((b) => b.addEventListener("click", () => {
    if (!confirm(confirmMsg)) return;
    busy(b, async () => { await api(b.dataset.del, { method: "DELETE" }); render(); });
  }));
}

// ---- forms
function foodForm(v) {
  return `<form class="form-grid">
    <label style="grid-column:1/-1">Description<input name="description" value="${esc(v.description)}" required></label>
    <label>Date<input name="date" type="date" value="${esc(v.date || state.date)}" required></label>
    <label>Time<input name="time" type="time" value="${esc(v.time || nowTime())}"></label>
    <label>Meal<select name="meal">${["breakfast", "lunch", "dinner", "snack", "drink"].map((m) => `<option ${v.meal === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <label>Calories<input name="calories" type="number" step="any" value="${esc(v.calories != null ? Math.round(v.calories) : "")}" required></label>
    <label>Protein g<input name="protein_g" type="number" step="any" value="${esc(v.protein_g)}"></label>
    <label>Carbs g<input name="carbs_g" type="number" step="any" value="${esc(v.carbs_g)}"></label>
    <label>Fat g<input name="fat_g" type="number" step="any" value="${esc(v.fat_g)}"></label>
    <label>Fibre g<input name="fiber_g" type="number" step="any" value="${esc(v.fiber_g)}"></label>
    <input type="hidden" name="items_json" value="${esc(v.items_json || "")}">
    <input type="hidden" name="source" value="${esc(v.source || "manual")}">
    <input type="hidden" name="sugar_g" value="${esc(v.sugar_g ?? "")}"><input type="hidden" name="sodium_mg" value="${esc(v.sodium_mg ?? "")}">
    <div class="row" style="align-items:end"><button class="primary">Save</button></div>
  </form>`;
}
function wireFoodForm(form, after) {
  form.addEventListener("submit", (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const f = Object.fromEntries(new FormData(form));
    for (const k of ["calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg"]) f[k] = num(f[k]);
    if (!f.items_json) delete f.items_json;
    await api("/food", { method: "POST", body: f });
    toast("Food saved"); after?.(); render();
  }); });
}

function exerciseForm(v, note = "") {
  return `<form class="form-grid card">
    ${note ? `<p class="muted" style="grid-column:1/-1;margin:0">${note}</p>` : ""}
    <label>Activity<input name="name" value="${esc(v.name || "")}" required></label>
    <label>Date<input name="date" type="date" value="${esc(v.date || state.date)}" required></label>
    <label>Category<select name="category">${["strength", "cardio", "hiit", "walk", "run", "cycle", "swim", "sport", "mobility", "other"].map((c) => `<option ${v.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label>Minutes<input name="duration_min" type="number" step="any" value="${esc(v.duration_min ?? "")}"></label>
    <label>Calories<input name="calories" type="number" step="any" value="${esc(v.calories != null ? Math.round(v.calories) : "")}" required></label>
    <input type="hidden" name="details_json" value="${esc(v.details_json || "")}">
    <div class="row" style="align-items:end"><button class="primary">Save</button></div>
  </form>`;
}
function wireExerciseForm(form, after) {
  form.addEventListener("submit", (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const f = Object.fromEntries(new FormData(form));
    f.calories = num(f.calories); f.duration_min = num(f.duration_min);
    if (!f.details_json) delete f.details_json;
    f.source = f.details_json ? "ai" : "manual";
    await api("/exercise", { method: "POST", body: f });
    toast("Exercise saved"); after?.(); render();
  }); });
}

const BODY_FIELDS = [
  ["weight_kg", "Weight kg"], ["bmi", "BMI"], ["body_fat_pct", "Body fat %"], ["muscle_mass_kg", "Muscle mass kg"],
  ["skeletal_muscle_pct", "Skeletal muscle %"], ["water_pct", "Water %"], ["bone_mass_kg", "Bone mass kg"],
  ["visceral_fat", "Visceral fat"], ["protein_pct", "Protein %"], ["bmr_kcal", "BMR kcal"], ["metabolic_age", "Metabolic age"],
];
function bodyForm(v) {
  return `<form class="form-grid">
    <label>Date<input name="date" type="date" value="${esc(v.date)}" required></label>
    <label>Time<input name="time" type="time" value="${esc(v.time || "")}"></label>
    ${BODY_FIELDS.map(([k, l]) => `<label>${l}<input name="${k}" type="number" step="any" value="${esc(v[k] ?? "")}"></label>`).join("")}
    <label style="grid-column:1/-1">Notes<input name="notes" value="${esc(v.notes || "")}"></label>
    <input type="hidden" name="source" value="${esc(v.source || "manual")}">
    <input type="hidden" name="extra_json" value="${esc(v.extra_json || "")}">
    <div class="row" style="align-items:end"><button class="primary">Save reading</button></div>
  </form>`;
}
function wireBodyForm(form, after) {
  form.addEventListener("submit", (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const f = Object.fromEntries(new FormData(form));
    for (const [k] of BODY_FIELDS) f[k] = num(f[k]);
    if (!f.extra_json) delete f.extra_json;
    await api("/body", { method: "POST", body: f });
    toast("Reading saved"); after?.(); render();
  }); });
}

// ------------------------------------------------------------------ parsers

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().replace(/^﻿/, ""));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Normalise many date formats to YYYY-MM-DD. Fitbit uses MM/DD/YY. */
function toISODate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : localDate(d);
}

/** Aggregate (date, metric) → value with sum or last/avg semantics. */
function aggregate(points, metric, mode = "sum", scale = 1) {
  const acc = new Map();
  for (const [date, v] of points) {
    if (!date || !Number.isFinite(v)) continue;
    const a = acc.get(date) || { s: 0, n: 0 };
    a.s += v; a.n += 1;
    acc.set(date, a);
  }
  return [...acc].map(([date, a]) => ({ date, metric, value: +((mode === "avg" ? a.s / a.n : a.s) * scale).toFixed(2), source: "fitbit" }));
}

/**
 * Recognise Fitbit / Google Takeout files by name and shape. Returns metric rows or null if unknown.
 * Formats are based on Fitbit's Takeout export; Google may change them — unknown files fall back to Claude.
 */
function parseHealthFile(name, text, { lbs }) {
  const base = name.toLowerCase().split("/").pop();
  if (base.endsWith(".json")) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(data) || !data.length) return Array.isArray(data) ? [] : null;
    const pts = (fn) => data.map((r) => { try { return fn(r); } catch { return [null, NaN]; } });
    const val = (r) => [toISODate(r.dateTime), Number(r.value)];
    if (base.startsWith("steps-")) return aggregate(pts(val), "steps");
    if (base.startsWith("distance-")) return aggregate(pts(val), "distance_km", "sum", 1 / 100000); // centimetres
    if (base.startsWith("calories-")) return aggregate(pts(val), "calories_out");
    if (base.startsWith("altitude-")) return null;
    if (base.startsWith("very_active_minutes-") || base.startsWith("moderately_active_minutes-")) return aggregate(pts(val), base.startsWith("very") ? "_very_active" : "_mod_active");
    if (base.startsWith("resting_heart_rate-")) return aggregate(pts((r) => [toISODate(r.value?.date || r.dateTime), Number(r.value?.value)]).filter((p) => p[1] > 0), "resting_hr", "avg");
    if (base.startsWith("sleep-")) return aggregate(pts((r) => [toISODate(r.dateOfSleep), Number(r.minutesAsleep)]), "sleep_minutes");
    if (base.startsWith("weight-")) {
      const k = lbs ? 1 / 2.20462 : 1;
      return [
        ...aggregate(pts((r) => [toISODate(r.date), Number(r.weight)]), "weight_kg", "avg", k),
        ...aggregate(pts((r) => [toISODate(r.date), r.fat == null ? NaN : Number(r.fat)]), "body_fat_pct", "avg"),
      ];
    }
    if (base.startsWith("heart_rate-")) return []; // per-second data: too large, not needed for daily view
    // Generic JSON: [{date|dateTime, value}] with metric guessed from file name
    const metric = guessMetric(base);
    if (metric && ("value" in data[0]) && (data[0].date || data[0].dateTime)) {
      return aggregate(pts((r) => [toISODate(r.date || r.dateTime), Number(typeof r.value === "object" ? r.value?.value : r.value)]), metric, "avg");
    }
    return null;
  }
  if (base.endsWith(".csv")) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    const cols = Object.keys(rows[0]);
    const find = (...re) => cols.find((c) => re.some((r) => r.test(c.toLowerCase())));
    // Fitbit "Daily Heart Rate Variability Summary": timestamp,rmssd,nremhr,entropy
    if (cols.includes("rmssd")) return aggregate(rows.map((r) => [toISODate(r.timestamp), Number(r.rmssd)]), "hrv_ms", "avg");
    // "Daily SpO2": timestamp,average_value,...
    if (cols.includes("average_value") && /spo2/.test(base)) return aggregate(rows.map((r) => [toISODate(r.timestamp), Number(r.average_value)]), "spo2_pct", "avg");
    if (cols.includes("overall_score")) return aggregate(rows.map((r) => [toISODate(r.timestamp), Number(r.overall_score)]), "sleep_score", "avg");
    if (/active zone minutes/.test(base) && cols.includes("total_minutes")) return aggregate(rows.map((r) => [toISODate(r.date_time), Number(r.total_minutes)]), "active_zone_minutes");
    if (/respiratory rate|breathing/.test(base) && cols.includes("daily_respiratory_rate")) return aggregate(rows.map((r) => [toISODate(r.timestamp), Number(r.daily_respiratory_rate)]), "breathing_rate", "avg");
    // Generic wide CSV: one date column + recognisable metric columns
    const dateCol = find(/^date$/, /^day$/, /date/, /^timestamp$/, /time/);
    if (!dateCol) return null;
    const map = {
      steps: [/^steps?$/, /step count/, /^total steps/],
      resting_hr: [/resting heart/, /resting_hr/, /^rhr$/],
      calories_out: [/calories burned/, /calories out/, /^calories$/, /total calories/, /energy burned/],
      distance_km: [/distance/],
      sleep_minutes: [/minutes asleep/, /sleep duration/, /^sleep/],
      active_minutes: [/active minutes/],
      weight_kg: [/^weight/],
      body_fat_pct: [/body fat|^fat/],
      hrv_ms: [/hrv|heart rate variability/],
      spo2_pct: [/spo2|oxygen/],
      floors: [/floors/],
    };
    const found = {};
    for (const [metric, res] of Object.entries(map)) { const c = find(...res); if (c && c !== dateCol) found[metric] = c; }
    if (!Object.keys(found).length) return null;
    const out = [];
    for (const [metric, col] of Object.entries(found)) {
      const l = col.toLowerCase();
      let k = 1;
      if (metric === "distance_km" && /\bmi(les)?\b/.test(l)) k = 1.60934;
      if (metric === "distance_km" && /\(m\)|meters|metres/.test(l)) k = 0.001;
      if (metric === "weight_kg" && (/lb/.test(l) || lbs)) k = 1 / 2.20462;
      if (metric === "sleep_minutes" && /hour|\(h\)/.test(l)) k = 60;
      const mode = ["steps", "calories_out", "distance_km", "active_minutes", "floors"].includes(metric) ? "sum" : "avg";
      out.push(...aggregate(rows.map((r) => [toISODate(r[dateCol]), Number(String(r[col]).replace(/,/g, ""))]), metric, mode, k));
    }
    return out;
  }
  return null;
}

function guessMetric(name) {
  if (/resting/.test(name)) return "resting_hr";
  if (/hrv|variability/.test(name)) return "hrv_ms";
  if (/spo2|oxygen/.test(name)) return "spo2_pct";
  if (/vo2/.test(name)) return "vo2max";
  return null;
}

/** Combine very+moderate active minutes and drop helper metrics; one row per (date, metric). */
function mergeMetricRows(rows) {
  const m = new Map();
  const active = new Map();
  for (const r of rows) {
    if (r.metric === "_very_active" || r.metric === "_mod_active") { active.set(r.date, (active.get(r.date) || 0) + r.value); continue; }
    const k = `${r.date}|${r.metric}`;
    const prev = m.get(k);
    // the same metric from several monthly files: sum counts, keep latest otherwise
    if (prev && ["steps", "calories_out", "distance_km", "sleep_minutes", "active_zone_minutes"].includes(r.metric)) prev.value = +(prev.value + r.value).toFixed(2);
    else m.set(k, { ...r });
  }
  for (const [date, v] of active) m.set(`${date}|active_minutes`, { date, metric: "active_minutes", value: v, source: "fitbit" });
  return [...m.values()].filter((r) => !(r.metric === "calories_out" && r.value < 500)); // partial days
}

/**
 * Fitbod CSV → one exercise entry per workout day.
 * Columns: Date, Exercise, Reps, Weight(kg|lbs), Duration(s), Distance(m), Incline, Resistance, isWarmup, Note, multiplier
 * Calories: active kcal ≈ (MET − 1) × kg × hours; strength MET 5.0 (≈2.5 min per set incl. rest), cardio MET 7.0.
 */
function parseFitbod(text, bodyKg) {
  const rows = parseCSV(text);
  if (!rows.length || !("Exercise" in rows[0])) throw new Error("This doesn't look like a Fitbod export (no 'Exercise' column).");
  const wCol = Object.keys(rows[0]).find((c) => /^weight/i.test(c));
  const lbs = wCol && /lb/i.test(wCol);
  const days = new Map();
  for (const r of rows) {
    const date = toISODate(r.Date);
    if (!date) continue;
    const d = days.get(date) || { sets: 0, cardioSec: 0, volume: 0, ex: new Map() };
    const reps = Number(r.Reps) || 0;
    const w = (Number(r[wCol]) || 0) * (lbs ? 0.453592 : 1);
    const dur = Number(r["Duration(s)"]) || 0;
    const warm = String(r.isWarmup).toLowerCase() === "true";
    if (dur > 0 && reps === 0) d.cardioSec += dur;
    else if (!warm) { d.sets += 1; d.volume += reps * w * (Number(r.multiplier) || 1); }
    const e = d.ex.get(r.Exercise) || { sets: 0, best: 0 };
    e.sets += 1; e.best = Math.max(e.best, w);
    d.ex.set(r.Exercise, e);
    days.set(date, d);
  }
  return [...days].map(([date, d]) => {
    const strengthMin = d.sets * 2.5;
    const cardioMin = d.cardioSec / 60;
    const kcal = 4.0 * bodyKg * (strengthMin / 60) + 6.0 * bodyKg * (cardioMin / 60);
    const summary = [...d.ex].map(([n, e]) => `${n} ×${e.sets}${e.best ? ` (${Math.round(e.best)} kg)` : ""}`).join(", ");
    return {
      date,
      name: "Fitbod workout",
      category: d.cardioSec > d.sets * 150 ? "cardio" : "strength",
      duration_min: Math.round(strengthMin + cardioMin),
      calories: Math.round(kcal),
      details_json: JSON.stringify({ details: summary, volume_kg: Math.round(d.volume), working_sets: d.sets, calories_source: "estimated (MET)" }),
      source: "fitbod",
      external_id: `fitbod-${date}`,
    };
  });
}

// ------------------------------------------------------------------ boot
try { const th = localStorage.getItem("hf_theme"); if (th) document.documentElement.dataset.theme = th; } catch {}
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (VIEWS[h] && h !== state.tab) { state.tab = h; render(); } });
if (TOKEN) start(); else logout();
