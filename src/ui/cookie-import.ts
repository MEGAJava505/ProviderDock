const maximumImportedCookies = 4096;
const maximumCookieHeaderBytes = 64 * 1024;
const cookieNamePattern = /^[^\s=;,\u0000-\u001f\u007f]+$/;

export interface ImportedCookie {
  readonly domain?: string;
  readonly hostOnly?: boolean;
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly expirationDate?: number;
  readonly expires?: number | string;
}

export interface CookieHeaderOptions {
  readonly protocol?: "http:" | "https:";
  readonly requestPaths?: readonly string[];
  readonly now?: number;
}

export class CookieImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieImportError";
  }
}

/** Reads the JSON, Header String and Netscape formats offered by Cookie-Editor. */
export function parseCookieEditorExport(raw: string): ImportedCookie[] {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) throw new CookieImportError("Cookie export is empty.");
  const cookies = source.startsWith("[") || source.startsWith("{")
    ? parseJsonExport(source)
    : looksLikeNetscapeExport(source)
      ? parseNetscapeExport(source)
      : parseHeaderStringExport(source);
  if (!cookies.length) throw new CookieImportError("Cookie export does not contain usable cookies.");
  if (cookies.length > maximumImportedCookies) {
    throw new CookieImportError("Cookie export contains more than " + maximumImportedCookies + " cookies.");
  }
  return cookies;
}

/** Builds one Cookie header scoped to one explicitly selected portal host. */
export function cookieHeaderForSite(
  rows: readonly ImportedCookie[],
  hostname: string,
  options: CookieHeaderOptions = {},
): string | undefined {
  const host = normalizeHostname(hostname);
  const paths = options.requestPaths?.length ? options.requestPaths.map(normalizeRequestPath) : ["/"];
  const now = options.now ?? Date.now();
  const protocol = options.protocol ?? "https:";
  const candidates = rows.map((cookie, index) => ({ cookie, index }))
    .filter(({ cookie }) => domainMatches(cookie, host))
    .filter(({ cookie }) => !cookie.secure || protocol === "https:")
    .filter(({ cookie }) => !isExpired(cookie, now))
    .filter(({ cookie }) => paths.some((path) => pathMatches(path, cookie.path ?? "/")))
    .sort((left, right) => specificity(right.cookie, host) - specificity(left.cookie, host)
      || left.index - right.index);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const { cookie } of candidates) {
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    values.push(cookie.name + "=" + cookie.value);
  }
  if (!values.length) return undefined;
  const header = values.join("; ");
  if (Buffer.byteLength(header, "utf8") > maximumCookieHeaderBytes) {
    throw new CookieImportError("Cookie header is larger than 64 KiB.");
  }
  return header;
}

function parseJsonExport(source: string): ImportedCookie[] {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new CookieImportError("Cookie-Editor JSON is malformed."); }
  const rows = Array.isArray(parsed) ? parsed
    : isRecord(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : undefined;
  if (!rows) throw new CookieImportError("Expected a JSON array or an object with a cookies array.");
  return rows.flatMap((row) => isRecord(row) ? normalizeCookie(row) : []);
}

function parseHeaderStringExport(source: string): ImportedCookie[] {
  if (/[\r\n]/.test(source)) throw new CookieImportError("Cookie header must be on one line.");
  return source.replace(/^cookie\s*:\s*/i, "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator < 1 ? [] : normalizeCookie({
      name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(),
    });
  });
}

function parseNetscapeExport(source: string): ImportedCookie[] {
  const cookies: ImportedCookie[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const expirationDate = Number(fields[4]);
    cookies.push(...normalizeCookie({
      domain: (fields[0] as string).replace(/^#HttpOnly_/, ""),
      hostOnly: String(fields[1]).toUpperCase() !== "TRUE",
      path: fields[2], secure: String(fields[3]).toUpperCase() === "TRUE",
      ...(Number.isFinite(expirationDate) && expirationDate > 0 ? { expirationDate } : {}),
      name: fields[5], value: fields.slice(6).join("\t"),
    }));
  }
  return cookies;
}

function normalizeCookie(row: Record<string, unknown>): ImportedCookie[] {
  if (typeof row.name !== "string" || typeof row.value !== "string") return [];
  const name = row.name.trim();
  const value = row.value;
  if (!cookieNamePattern.test(name) || /[;\u0000-\u001f\u007f]/.test(value)) return [];
  const domain = typeof row.domain === "string" ? normalizeCookieDomain(row.domain) : undefined;
  if (typeof row.domain === "string" && !domain) return [];
  const path = typeof row.path === "string" && safePath(row.path) ? row.path : "/";
  const expirationDate = finiteNumber(row.expirationDate);
  const expires = typeof row.expires === "string" || typeof row.expires === "number" ? row.expires : undefined;
  return [{
    ...(domain ? { domain } : {}),
    ...(typeof row.hostOnly === "boolean" ? { hostOnly: row.hostOnly } : {}),
    name, value, path,
    ...(typeof row.secure === "boolean" ? { secure: row.secure } : {}),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    ...(expires === undefined ? {} : { expires }),
  }];
}

function looksLikeNetscapeExport(source: string): boolean {
  return /^#\s*Netscape HTTP Cookie File/im.test(source)
    || source.split(/\r?\n/).some((line) => line.split("\t").length >= 7);
}

function normalizeCookieDomain(value: string): string | undefined {
  const domain = value.replace(/^#HttpOnly_/, "").replace(/^\./, "").trim().toLowerCase();
  if (!domain || /[\s/:\\\u0000-\u001f\u007f]/.test(domain)) return undefined;
  try { return new URL("https://" + domain).hostname.toLowerCase(); }
  catch { return undefined; }
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/^\./, "");
  if (!hostname) throw new CookieImportError("Portal hostname is empty.");
  return hostname;
}

function domainMatches(cookie: ImportedCookie, hostname: string): boolean {
  if (!cookie.domain) return true;
  if (cookie.hostOnly) return hostname === cookie.domain;
  return hostname === cookie.domain || hostname.endsWith("." + cookie.domain);
}

function normalizeRequestPath(value: string): string {
  return value.startsWith("/") ? value : "/" + value;
}

function safePath(value: string): boolean {
  return value.startsWith("/") && !/[\r\n\u0000]/.test(value);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === "/") return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return requestPath.length === cookiePath.length || cookiePath.endsWith("/")
    || requestPath[cookiePath.length] === "/";
}

function isExpired(cookie: ImportedCookie, now: number): boolean {
  const expiresAt = cookie.expirationDate ?? parseExpires(cookie.expires);
  return expiresAt !== undefined && expiresAt > 0 && expiresAt * 1000 <= now;
}

function parseExpires(value: ImportedCookie["expires"]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10000000000 ? value / 1000 : value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 10000000000 ? numeric / 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

function specificity(cookie: ImportedCookie, hostname: string): number {
  const domainScore = cookie.domain === hostname ? 10000 : cookie.domain?.length ?? 0;
  return (cookie.hostOnly ? 100000 : 0) + domainScore + (cookie.path?.length ?? 1);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
