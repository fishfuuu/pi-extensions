/**
 * Credential resolution for pi-db.
 *
 * Kept in its own module, free of Pi runtime imports, so the environment
 * boundary can be tested without a database or a Pi session.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    let key = s.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function findEnvFile(projectRoot: string, envFile: string): string | undefined {
  const envPath = path.join(projectRoot, envFile);
  return fs.existsSync(envPath) ? envPath : undefined;
}

/**
 * Load database credentials from an env file.
 *
 * `allowProcessEnv` exists because the ambient process environment is not part
 * of a named target's boundary. For a named target the selected env file is
 * authoritative and `process.env` is never consulted. Required connection fields
 * (HOST, NAME, USER) that are missing or empty fail closed. Optional/defaulted
 * fields retain their existing semantics: PASSWORD may be empty and PORT keeps
 * the existing default. Legacy single-target configs keep the historical
 * fallback so nothing regresses.
 */
export function loadDbConfig(
  projectRoot: string,
  envFile: string,
  envPrefix: string,
  allowProcessEnv: boolean
): { ok: true; cfg: DbConfig } | { ok: false; error: string } {
  const envPath = findEnvFile(projectRoot, envFile);
  if (!envPath) {
    return { ok: false, error: `no .env found at ${envFile}; refuse localhost` };
  }
  const env = parseEnvFile(envPath);

  // For named targets, an empty file value never falls through to process.env;
  // downstream validation/defaulting semantics remain unchanged.
  const read = (suffix: string): string | undefined => {
    const key = `${envPrefix}${suffix}`;
    const fromFile = env[key];
    if (!allowProcessEnv) return fromFile;
    return fromFile || process.env[key];
  };

  const host = (read("HOST") || "").trim();
  const database = (read("NAME") || "").trim();
  const user = (read("USER") || "").trim();
  const password = read("PASSWORD") || "";
  const portRaw = read("PORT") || "3306";
  const port = Number(portRaw);

  // Named targets say so explicitly: an operator hitting this needs to know the
  // ambient environment was deliberately not consulted.
  const scope = allowProcessEnv ? "in .env" : `in ${envFile} (named targets do not fall back to process.env)`;

  if (!host || !database) {
    return { ok: false, error: `${envPrefix}HOST or ${envPrefix}NAME missing ${scope}; refuse localhost` };
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return { ok: false, error: `${envPrefix}HOST is localhost; refuse (MySQL is remote, dotenv was not applied)` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `${envPrefix}PORT is invalid` };
  }
  if (!user) {
    return {
      ok: false,
      error: allowProcessEnv ? `${envPrefix}USER missing` : `${envPrefix}USER missing ${scope}`,
    };
  }
  return { ok: true, cfg: { host, port, user, password, database } };
}
