import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(time = Date.now()): string {
  let value = time;
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = ALPHABET[value % 32] + output;
    value = Math.floor(value / 32);
  }
  const bytes = randomBytes(16);
  for (const byte of bytes) output += ALPHABET[byte % 32];
  return output;
}

export function iso(date: Date, zone = "America/Sao_Paulo"): string {
  return DateTime.fromJSDate(date, { zone }).toISO() ?? date.toISOString();
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.toJSDate() : null;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secretsMatch(header: string | undefined, secrets: string[]): boolean {
  if (!header) return false;
  const given = Buffer.from(header);
  return secrets.some((secret) => {
    const expected = Buffer.from(secret);
    if (expected.length !== given.length) return false;
    return timingSafeEqual(expected, given);
  });
}

export function asBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}
