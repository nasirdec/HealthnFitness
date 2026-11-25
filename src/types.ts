export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
}
