import * as functions from 'firebase-functions';
// Local env variable support (only for emulator / local tooling). We lazy-load so production
// deployments (where .env is not present) don't error. We intentionally avoid logging secrets.
import * as path from 'path';
import * as fs from 'fs';

let _envLoaded = false;
function loadDotEnvIfPresent() {
  if (_envLoaded) return;
  _envLoaded = true;
  // If key already present, skip (could be provided via deploy-time vars or functions.config())
  if (process.env.RECEIPTS_SECRET || process.env.KMS_KEY_PATH) return;
  // Prefer a .env inside functions/ for clarity; fall back to repo root .env if found.
  const candidatePaths = [
    path.join(__dirname, '..', '.env'),              // functions/.env (after build __dirname -> lib/)
    path.join(__dirname, '..', '..', '.env'),        // repo root .env when running ts-node or compiled
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        // Dynamically import dotenv to avoid hard dependency if tree-shaken in future.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const dotenv = require('dotenv');
        dotenv.config({ path: p });
        break; // First found wins.
      }
    } catch {
      // Silently ignore; absence is fine in production.
    }
  }
}

// Centralized runtime configuration loader.
// Priority order: explicit environment variables (.env or deploy-time) -> legacy functions.config() (to be phased out before March 2026 deprecation).
// Keeping a single resolution point reduces drift and simplifies future Secret Manager migration.

export interface RuntimeConfig {
  receiptsSecret?: string;
  kmsKeyPath?: string;
}

let _cached: RuntimeConfig | null = null;

export function loadRuntimeConfig(): RuntimeConfig {
  if (_cached) return _cached;
  // Ensure we attempt local .env load before reading process.env
  loadDotEnvIfPresent();
  const fc = safeFunctionsConfig();
  const receiptsSecret = process.env.RECEIPTS_SECRET || fc.receipts?.secret;
  const kmsKeyPath = process.env.KMS_KEY_PATH || fc.kms?.keypath;
  _cached = { receiptsSecret, kmsKeyPath };
  return _cached;
}

function safeFunctionsConfig(): any {
  try {
    return functions.config ? functions.config() : {};
  } catch {
    return {};
  }
}

export function getReceiptSecret(): string | undefined {
  return loadRuntimeConfig().receiptsSecret;
}

export function getKmsKeyPath(): string | undefined {
  return loadRuntimeConfig().kmsKeyPath;
}
