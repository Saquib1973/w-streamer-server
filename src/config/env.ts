import "dotenv/config";
import { z } from "zod";

const durationRe = /^\d+(ms|s|m|h|d)$/;

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().default("*"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  ALLOW_LAN_ADDONS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  DATABASE_URL: z.string().startsWith("postgres"),
  DIRECT_URL: z.string().startsWith("postgres"),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  STREAM_TOKEN_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().regex(durationRe).default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  STREAM_TOKEN_TTL: z.string().regex(durationRe).default("6h"),

  ADMIN_SETUP_TOKEN: z.string().min(16),

  VAULT_ACTIVE_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  TORRENT_CACHE_DIR: z.string().default("./.torrent-cache"),
  TORRENT_MAX_CONNS: z.coerce.number().int().min(10).max(500).default(80),
  TORRENT_IDLE_TIMEOUT_MIN: z.coerce.number().int().min(1).default(20),
  TORRENT_MAX_ACTIVE: z.coerce.number().int().min(1).max(50).default(4),
  TORRENT_METADATA_TIMEOUT_SEC: z.coerce.number().int().min(5).max(180).default(30),

  ADDON_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
});

// On Render, the service's public https URL is provided automatically.
if (!process.env.PUBLIC_BASE_URL && process.env.RENDER_EXTERNAL_URL) process.env.PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  for (const i of parsed.error.issues) console.error(`   • ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}

/** Vault key ring: VAULT_KEY_V1, VAULT_KEY_V2, … each 32 bytes base64. */
function loadVaultKeys(): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^VAULT_KEY_V(\d+)$/.exec(k);
    if (!m || !v) continue;
    const buf = Buffer.from(v, "base64");
    if (buf.length !== 32) {
      console.error(`❌ ${k} must decode to exactly 32 bytes (got ${buf.length})`);
      process.exit(1);
    }
    keys.set(Number(m[1]), buf);
  }
  return keys;
}

export const env = parsed.data;
export const vaultKeys = loadVaultKeys();

if (!vaultKeys.has(env.VAULT_ACTIVE_KEY_VERSION)) {
  console.error(`❌ VAULT_KEY_V${env.VAULT_ACTIVE_KEY_VERSION} (active vault key) is not set`);
  process.exit(1);
}

export const isProd = env.NODE_ENV === "production";

/** "15m" → 900000 */
export function durationToMs(d: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
  return n * unit;
}
