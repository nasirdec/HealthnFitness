import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Env } from "./types";

/** A file sent from the browser as base64 (no data: prefix). */
export interface Attachment {
  media_type: string;
  data: string;
}

type Effort = "low" | "medium" | "high";

export class AIError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

function client(env: Env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AIError("ANTHROPIC_API_KEY is not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY`.", 503);
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function attachmentBlock(a: Attachment): Anthropic.Beta.BetaContentBlockParam {
  if (a.media_type === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } };
  }
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
  const mt = allowed.find((m) => m === a.media_type);
  if (!mt) throw new AIError(`Unsupported file type ${a.media_type}. Use JPEG, PNG, WebP, GIF or PDF.`, 400);
  return { type: "image", source: { type: "base64", media_type: mt, data: a.data } };
}

function buildContent(text: string, attachments: Attachment[] = []): Anthropic.Beta.BetaContentBlockParam[] {
  return [...attachments.map(attachmentBlock), { type: "text", text }];
}

async function structured<S extends z.ZodType>(
  env: Env,
  schema: S,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[],
  effort: Effort = "medium",
): Promise<z.infer<S>> {
  try {
    const response = await client(env).beta.messages.parse({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") {
      throw new AIError("The model declined this request. Try rephrasing or entering the values manually.", 422);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AIError("The response was cut off (document too long). Try splitting the file.", 422);
    }
    if (!response.parsed_output) throw new AIError("Could not parse the model's response.");
    return response.parsed_output as z.infer<S>;
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AIError("Claude API key is invalid.", 503);
    if (err instanceof Anthropic.RateLimitError) throw new AIError("Claude API rate limit hit; try again shortly.", 429);
    if (err instanceof Anthropic.BadRequestError) throw new AIError(`Claude API rejected the request: ${err.message}`, 400);
    if (err instanceof Anthropic.APIError) throw new AIError(`Claude API error ${err.status}: ${err.message}`);
    throw err;
  }
}

const num = z.number().nullable();

// ---------------------------------------------------------------- Food
export const FoodEstimate = z.object({
  meal: z.enum(["breakfast", "lunch", "dinner", "snack", "drink"]).nullable(),
  items: z.array(
    z.object({
      name: z.string(),
      portion: z.string().describe("Estimated portion with metric amount, e.g. '1 cup (180 g)'"),
      calories: z.number(),
      protein_g: z.number(),
      carbs_g: z.number(),
      fat_g: z.number(),
      fiber_g: z.number(),
    }),
  ),
  total: z.object({
    calories: z.number(),
    protein_g: z.number(),
    carbs_g: z.number(),
    fat_g: z.number(),
    fiber_g: z.number(),
    sugar_g: num,
    sodium_mg: num,
  }),
  description: z.string().describe("Short one-line description of the meal"),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().describe("Assumptions made, or what to clarify to improve accuracy"),
});

export function estimateFood(env: Env, text: string, attachments: Attachment[]) {
  return structured(
    env,
    FoodEstimate,
    "You are a registered-dietitian-grade nutrition estimator. Identify every food and drink in the photo and/or description, " +
      "estimate realistic portion sizes in metric units, and estimate calories and macronutrients using standard nutrition " +
      "databases (USDA / Canadian Nutrient File). Account for cooking oils, sauces and dressings that are typically used. " +
      "If a nutrition label is visible, use it. Totals must equal the sum of items. Be honest about uncertainty in notes.",
    buildContent(text ? `Meal description from the user: ${text}` : "Estimate the nutrition of the meal in this photo.", attachments),
    "medium",
  );
}

// ---------------------------------------------------------------- Smart scale
export const ScaleReading = z.object({
  date: z.string().nullable().describe("YYYY-MM-DD if visible on the screen, else null"),
  time: z.string().nullable().describe("HH:MM 24h if visible, else null"),
  weight_kg: num,
  bmi: num,
  body_fat_pct: num,
  muscle_mass_kg: num,
  skeletal_muscle_pct: num,
  water_pct: num,
  bone_mass_kg: num,
  visceral_fat: num,
  protein_pct: num,
  bmr_kcal: num,
  metabolic_age: num,
  other: z.array(z.object({ label: z.string(), value: z.string() })).describe("Any other readings shown"),
  notes: z.string(),
});

export function extractScale(env: Env, attachments: Attachment[], hint: string) {
  return structured(
    env,
    ScaleReading,
    "You extract readings from photos/screenshots of smart scales and body-composition apps. Read the numbers exactly as shown. " +
      "Convert to metric: pounds to kg (divide by 2.20462), and muscle/bone mass shown in lb to kg. Use null for readings not shown. " +
      "Never guess a value that is not visible.",
    buildContent(`Extract every reading from this scale image.${hint ? ` User note: ${hint}` : ""}`, attachments),
    "medium",
  );
}

// ---------------------------------------------------------------- Blood tests
export const LabReport = z.object({
  report_date: z.string().nullable().describe("Sample collection date as YYYY-MM-DD"),
  lab_name: z.string().nullable(),
  results: z.array(
    z.object({
      panel: z.string().nullable().describe("e.g. Lipid panel, CBC, Metabolic panel, Thyroid"),
      test_name: z.string().describe("Common name, e.g. 'LDL Cholesterol', 'HbA1c', 'TSH'"),
      test_key: z
        .string()
        .describe("Stable snake_case key for trending across labs, e.g. ldl_cholesterol, hba1c, tsh, vitamin_d_25oh, fasting_glucose"),
      value: num.describe("Numeric value, null if non-numeric"),
      value_text: z.string().nullable().describe("Raw value text if non-numeric, e.g. 'Negative' or '<0.1'"),
      unit: z.string().nullable(),
      ref_low: num,
      ref_high: num,
      ref_text: z.string().nullable(),
      flag: z.enum(["low", "high", "normal", "abnormal", "unknown"]),
    }),
  ),
  summary: z.string().describe("3-6 sentence plain-English summary of notable findings. Not a diagnosis."),
});

export function extractLabs(env: Env, attachments: Attachment[]) {
  return structured(
    env,
    LabReport,
    "You extract structured data from blood test / laboratory reports (Canadian, US and other labs). Extract EVERY analyte with " +
      "its value, unit and reference range exactly as printed; keep the lab's units (e.g. mmol/L). Use consistent test_key values so " +
      "results can be trended across different labs. Set flag from the report's own H/L markers or by comparing with the reference range.",
    buildContent("Extract all results from this lab report.", attachments),
    "high",
  );
}

// ---------------------------------------------------------------- Exercise
export const ExerciseEstimate = z.object({
  activities: z.array(
    z.object({
      date: z.string().nullable().describe("YYYY-MM-DD if stated, else null"),
      name: z.string(),
      category: z.enum(["strength", "cardio", "hiit", "walk", "run", "cycle", "swim", "sport", "mobility", "other"]),
      duration_min: num,
      calories: z.number().describe("Active calories burned (above resting). Use the device's value if shown."),
      calories_source: z.enum(["device", "estimated"]),
      details: z.string().describe("Sets/reps/weights, distance, avg HR, etc."),
    }),
  ),
  notes: z.string(),
});

export function estimateExercise(env: Env, text: string, attachments: Attachment[], weightKg: number | null) {
  return structured(
    env,
    ExerciseEstimate,
    "You log workouts from screenshots (Fitbod, Fitbit, Apple/Google fitness, gym machines) or text descriptions. If the source shows " +
      "calories, use that number (calories_source=device). Otherwise estimate ACTIVE calories using MET values from the Compendium " +
      "of Physical Activities: kcal = (MET - 1) x body_weight_kg x hours. For resistance training estimate duration from sets " +
      "(about 2.5 minutes per set including rest) if not given.",
    buildContent(
      `User body weight: ${weightKg ? `${weightKg} kg` : "unknown (assume 80 kg)"}.\n${text ? `Workout: ${text}` : "Log the workout(s) in this image."}`,
      attachments,
    ),
    "medium",
  );
}

// ---------------------------------------------------------------- Vitals report (Google Health / Fitbit)
export const VitalsReport = z.object({
  days: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD"),
      metrics: z.array(
        z.object({
          metric: z
            .enum([
              "steps", "resting_hr", "calories_out", "active_minutes", "distance_km", "sleep_minutes",
              "sleep_score", "hrv_ms", "spo2_pct", "breathing_rate", "floors", "vo2max", "weight_kg",
              "body_fat_pct", "skin_temp_variation_c", "active_zone_minutes",
            ]),
          value: z.number(),
        }),
      ),
    }),
  ),
  notes: z.string(),
});

export function extractVitals(env: Env, text: string, attachments: Attachment[]) {
  return structured(
    env,
    VitalsReport,
    "You convert health-tracker exports and reports (Fitbit, Google Health / Health Connect, Google Fit) into daily metrics. " +
      "Produce one entry per calendar day. Convert to metric units (distance km, weight kg, temperature C). Steps and calories " +
      "are daily totals; sleep_minutes is time asleep; resting_hr in bpm; hrv_ms is RMSSD in ms. Omit metrics that are absent.",
    buildContent(text ? `Export data:\n${text}` : "Extract daily metrics from this report.", attachments),
    "medium",
  );
}

// ---------------------------------------------------------------- Insights
export async function generateInsights(env: Env, dataSummary: string): Promise<string> {
  try {
    const response = await client(env).beta.messages.create({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      system:
        "You are a careful health and fitness coach reviewing one person's tracked data. Use Canadian English and metric units. " +
        "Write concise markdown with these sections: Snapshot, Progress toward goals, Nutrition, Training, Vitals & sleep, " +
        "Blood work (flag out-of-range values and trends; do not diagnose and say when to talk to a doctor), and " +
        "Recommendations (3-6 specific, measurable actions, including a recalibrated daily calorie and protein target with the reasoning). " +
        "Point out data gaps or likely double counting (e.g. tracker calories already including logged workouts). Be direct.",
      messages: [{ role: "user", content: `Here is my data (JSON):\n${dataSummary}` }],
    });
    if (response.stop_reason === "refusal") throw new AIError("The model declined to generate insights.", 422);
    return response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err instanceof Anthropic.APIError) throw new AIError(`Claude API error ${err.status}: ${err.message}`);
    throw err;
  }
}
