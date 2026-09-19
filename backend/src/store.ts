/** Durable beta storage. Legacy JSON files are never imported implicitly. */
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Bundle } from "../../collector/src/report.ts";
import { parseBundle, looksLikeBundle, ValidationError } from "./validation.ts";
import { scorePopulation } from "./scoring.ts";
export { looksLikeBundle, parseBundle, ValidationError };

export interface User { handle: string; createdAt: string; isPublic: boolean; }
export interface PopulationEntry { handle: string; synthetic: boolean; persona?: string; bundle: Bundle; }
export interface CredentialUser extends User { token: string; recoveryCode?: string; }
let connection: DatabaseSync | undefined;
let openedPath: string | undefined;

/** Shared connection for platform tables. Use transactions for multi-statement mutations. */
export function getDatabase(): DatabaseSync {
  const dir = resolve(process.env.VIBESCORE_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data"));
  const path = join(dir, "vibescore.sqlite");
  if (connection && openedPath === path) return connection;
  connection?.close();
  mkdirSync(dir, { recursive: true });
  connection = new DatabaseSync(path);
  openedPath = path;
  connection.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      handle TEXT PRIMARY KEY, created_at TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT, recovery_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      hash TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES users(handle) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('api','session')), expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS credentials_handle ON credentials(handle);
    CREATE TABLE IF NOT EXISTS bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT NOT NULL REFERENCES users(handle) ON DELETE CASCADE,
      digest TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(handle,digest)
    );
    CREATE INDEX IF NOT EXISTS bundles_handle ON bundles(handle,id);
    CREATE TABLE IF NOT EXISTS score_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT NOT NULL REFERENCES users(handle) ON DELETE CASCADE,
      bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
      score TEXT NOT NULL, population_snapshot TEXT NOT NULL, computed_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS immutable_bundles BEFORE UPDATE ON bundles BEGIN SELECT RAISE(ABORT, 'bundles are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_scores BEFORE UPDATE ON score_history BEGIN SELECT RAISE(ABORT, 'score history is immutable'); END;
  `);
  return connection;
}
export const database = getDatabase;
export function closeDatabase(): void { connection?.close(); connection = undefined; openedPath = undefined; }
function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDatabase(); db.exec("BEGIN IMMEDIATE");
  try { const result = fn(db); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (): string => randomBytes(32).toString("base64url");
const userView = (row: any): User => ({ handle: row.handle, createdAt: row.created_at, isPublic: row.is_public === 1 });
export function validHandle(h: unknown): h is string { return typeof h === "string" && /^[a-z0-9][a-z0-9_-]{1,23}$/.test(h); }
export function validPassword(p: unknown): p is string { return typeof p === "string" && p.length >= 10 && p.length <= 128; }
function passwordHash(password: string): string {
  if (!validPassword(password)) throw new ValidationError("password must contain 10 to 128 characters");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function passwordMatches(password: unknown, encoded: string | null | undefined): boolean {
  if (typeof password !== "string" || password.length > 128) return false;
  const [salt, expected] = (encoded ?? `${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, "hex")) && !!encoded;
}
function credential(db: DatabaseSync, handle: string, kind: "api" | "session"): string {
  const token = opaque();
  db.prepare("INSERT INTO credentials(hash,handle,kind,expires_at) VALUES(?,?,?,?)")
    .run(hash(token), handle, kind, kind === "session" ? Date.now() + 7 * 86400_000 : null);
  return token;
}
export function listUsers(): User[] { return getDatabase().prepare("SELECT * FROM users ORDER BY handle").all().map(userView); }
export function getUser(handle: string): User | undefined {
  const row = getDatabase().prepare("SELECT * FROM users WHERE handle=?").get(handle);
  return row ? userView(row) : undefined;
}
export function registerUser(handle: string, password?: string): (CredentialUser & { recoveryCode: string }) | null {
  if (!validHandle(handle)) throw new ValidationError("invalid handle");
  const encoded = password === undefined ? null : passwordHash(password);
  return transaction(db => {
    if (db.prepare("SELECT 1 FROM users WHERE handle=?").get(handle)) return null;
    const createdAt = new Date().toISOString(), recoveryCode = opaque();
    db.prepare("INSERT INTO users(handle,created_at,password_hash,recovery_hash) VALUES(?,?,?,?)").run(handle, createdAt, encoded, hash(recoveryCode));
    return { handle, createdAt, isPublic: false, token: credential(db, handle, "api"), recoveryCode };
  });
}
export function userByToken(token: string): User | undefined {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return undefined;
  const row = getDatabase().prepare(`SELECT u.* FROM users u JOIN credentials c ON c.handle=u.handle
    WHERE c.hash=? AND (c.expires_at IS NULL OR c.expires_at>?)`).get(hash(token), Date.now());
  return row ? userView(row) : undefined;
}
export function loginUser(handle: string, password: string): CredentialUser | null {
  const row: any = getDatabase().prepare("SELECT * FROM users WHERE handle=?").get(handle);
  if (!passwordMatches(password, row?.password_hash)) return null;
  return { ...userView(row), token: credential(getDatabase(), handle, "session") };
}
export function changePassword(handle: string, currentPassword: string, newPassword: string): boolean {
  const row: any = getDatabase().prepare("SELECT password_hash FROM users WHERE handle=?").get(handle);
  if (!row || !passwordMatches(currentPassword, row.password_hash)) return false;
  const encoded = passwordHash(newPassword);
  transaction(db => {
    db.prepare("UPDATE users SET password_hash=? WHERE handle=?").run(encoded, handle);
    db.prepare("DELETE FROM credentials WHERE handle=?").run(handle);
  });
  return true;
}
export function recoverAccount(handle: string, recoveryCode: string, newPassword: string): { token: string; recoveryCode: string } | null {
  if (typeof recoveryCode !== "string" || recoveryCode.length > 256) return null;
  const row: any = getDatabase().prepare("SELECT recovery_hash FROM users WHERE handle=?").get(handle);
  if (!row || !timingSafeEqual(Buffer.from(hash(recoveryCode), "hex"), Buffer.from(row.recovery_hash, "hex"))) return null;
  const encoded = passwordHash(newPassword), nextCode = opaque();
  return transaction(db => {
    db.prepare("UPDATE users SET password_hash=?,recovery_hash=? WHERE handle=?").run(encoded, hash(nextCode), handle);
    db.prepare("DELETE FROM credentials WHERE handle=?").run(handle);
    return { token: credential(db, handle, "session"), recoveryCode: nextCode };
  });
}
export function rotateToken(handle: string): string {
  return transaction(db => {
    db.prepare("DELETE FROM credentials WHERE handle=? AND kind='api'").run(handle);
    return credential(db, handle, "api");
  });
}
export function revokeToken(token: string): void { getDatabase().prepare("DELETE FROM credentials WHERE hash=?").run(hash(token)); }
export function revokeSessions(handle: string): void { getDatabase().prepare("DELETE FROM credentials WHERE handle=? AND kind='session'").run(handle); }
export function setVisibility(handle: string, isPublic: boolean): User | null {
  if (typeof isPublic !== "boolean") throw new ValidationError("isPublic must be boolean");
  getDatabase().prepare("UPDATE users SET is_public=? WHERE handle=?").run(isPublic ? 1 : 0, handle);
  return getUser(handle) ?? null;
}
export function deleteUser(handle: string): boolean {
  return transaction(db => Number(db.prepare("DELETE FROM users WHERE handle=?").run(handle).changes) > 0);
}

export function loadBundle(handle: string): Bundle | null {
  const row: any = getDatabase().prepare("SELECT body FROM bundles WHERE handle=? ORDER BY id DESC LIMIT 1").get(handle);
  return row ? parseBundle(JSON.parse(row.body)) : null;
}
function latestRows(publicOnly = false): any[] {
  return getDatabase().prepare(`SELECT b.* FROM bundles b JOIN users u ON u.handle=b.handle
    WHERE b.id=(SELECT MAX(id) FROM bundles WHERE handle=b.handle) ${publicOnly ? "AND u.is_public=1" : ""} ORDER BY b.handle`).all();
}
export function loadPopulation(): PopulationEntry[] {
  return latestRows().map(row => ({ handle: row.handle, synthetic: false, bundle: parseBundle(JSON.parse(row.body)) }));
}
export function loadPublicPopulation(): PopulationEntry[] {
  return latestRows(true).map(row => ({ handle: row.handle, synthetic: false, bundle: parseBundle(JSON.parse(row.body)) }));
}
/** Append-only evidence and score snapshot are committed together. Duplicate evidence is idempotent. */
export function saveBundle(handle: string, bundle: Bundle): void {
  const clean = parseBundle(bundle), body = JSON.stringify(clean), digest = hash(body);
  transaction(db => {
    const existing = db.prepare("SELECT id FROM bundles WHERE handle=? AND digest=?").get(handle, digest);
    if (existing) return;
    const now = new Date().toISOString();
    const result = db.prepare("INSERT INTO bundles(handle,digest,body,created_at) VALUES(?,?,?,?)").run(handle, digest, body, now);
    const rows = latestRows();
    const population = rows.map(row => ({ handle: row.handle, synthetic: false, bundle: parseBundle(JSON.parse(row.body)) }));
    const score = scorePopulation(population).find(s => s.handle === handle);
    if (!score) throw new Error("submitted evidence could not be scored");
    const snapshot = rows.map(row => ({ handle: row.handle, bundleId: row.id, digest: row.digest }));
    db.prepare("INSERT INTO score_history(handle,bundle_id,score,population_snapshot,computed_at) VALUES(?,?,?,?,?)")
      .run(handle, result.lastInsertRowid, JSON.stringify(score), JSON.stringify(snapshot), now);
  });
}
export function scoreHistory(handle: string, limit = 100): any[] {
  const count = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 100));
  return getDatabase().prepare("SELECT id,bundle_id,score,computed_at FROM score_history WHERE handle=? ORDER BY id DESC LIMIT ?")
    .all(handle, count).map((row: any) => ({ id: row.id, bundleId: row.bundle_id, computedAt: row.computed_at, ...JSON.parse(row.score) }));
}
