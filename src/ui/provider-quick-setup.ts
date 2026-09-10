export type QuickSetupAuthKind = "none" | "bearer" | "header" | "query";

export interface ProviderQuickSetup {
  readonly requestUrl: string;
  readonly baseUrl: string;
  readonly id: string;
  readonly displayName: string;
  readonly apiType:
    | "auto"
    | "openai-responses"
    | "openai-chat-completions"
    | "anthropic-messages";
  readonly adapterId:
    | "generic-openai"
    | "generic-anthropic"
    | "agentrouter"
    | "gorouter";
  readonly authKind: QuickSetupAuthKind;
  readonly authName: string;
  readonly secretRef: string;
  readonly secretValue?: string;
  readonly staticHeaders: Readonly<Record<string, string>>;
  readonly queryParameters: Readonly<Record<string, string>>;
  readonly manualModelIds: readonly string[];
}

/**
 * Infers the common provider fields from either an API URL or a copied cURL request.
 * The function is deliberately self-contained because its compiled source is also
 * embedded in the loopback dashboard and runs locally in the browser.
 */
export function inferProviderQuickSetup(example: string): ProviderQuickSetup {
  const input = example.trim();
  if (!input) throw new Error("Сначала вставьте URL API или пример cURL.");

  const urlMatch = input.match(/https?:\/\/[^\s"'\\]+/i);
  if (!urlMatch) throw new Error("В примере не найден URL API с HTTP(S).");
  const requestUrlText = urlMatch[0].replace(/[),;]+$/, "");
  let requestUrl: URL;
  try {
    requestUrl = new URL(requestUrlText);
  } catch {
    throw new Error("Определённый URL API некорректен.");
  }

  const headers: Array<[string, string]> = [];
  const headerPattern = /(?:^|\s)(?:-H|--header)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s\\]+))/gi;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(input)) !== null) {
    const header = headerMatch[1] ?? headerMatch[2] ?? headerMatch[3] ?? "";
    const separator = header.indexOf(":");
    if (separator > 0) {
      headers.push([
        header.slice(0, separator).trim(),
        header.slice(separator + 1).trim(),
      ]);
    }
  }

  if (headers.length === 0) {
    const knownHeaderNames = new Set([
      "authorization",
      "x-api-key",
      "api-key",
      "anthropic-version",
      "content-type",
      "accept",
    ]);
    for (const line of input.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/.exec(line);
      if (match && knownHeaderNames.has((match[1] as string).toLowerCase())) {
        headers.push([match[1] as string, match[2] as string]);
      }
    }
  }

  const hostname = requestUrl.hostname.toLowerCase();
  const pathname = requestUrl.pathname.replace(/\/+$/, "");
  let apiType: ProviderQuickSetup["apiType"] = "auto";
  if (/\/messages$/i.test(pathname) || hostname.includes("anthropic")) {
    apiType = "anthropic-messages";
  } else if (/\/responses$/i.test(pathname)) {
    apiType = "openai-responses";
  } else if (/\/chat\/completions$/i.test(pathname)) {
    apiType = "openai-chat-completions";
  }

  let adapterId: ProviderQuickSetup["adapterId"];
  if (hostname.includes("agentrouter")) adapterId = "agentrouter";
  else if (hostname.includes("gorouter")) adapterId = "gorouter";
  else if (apiType === "anthropic-messages") adapterId = "generic-anthropic";
  else adapterId = "generic-openai";

  const friendlyNames: Readonly<Record<string, string>> = {
    "api.openai.com": "OpenAI",
    "api.anthropic.com": "Anthropic",
    "openrouter.ai": "OpenRouter",
    "agentrouter.org": "AgentRouter",
  };
  const hostPart = hostname
    .split(".")
    .find((part) => !["www", "api", "gateway", "v1"].includes(part));
  const displayName =
    friendlyNames[hostname] ??
    (hostPart
      ? hostPart.charAt(0).toUpperCase() + hostPart.slice(1).replace(/[-_]+/g, " ")
      : "Provider");
  const id = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "provider";

  const staticHeaders: Record<string, string> = {};
  let authKind: QuickSetupAuthKind =
    apiType === "anthropic-messages" ? "header" : "bearer";
  let authName = apiType === "anthropic-messages" ? "x-api-key" : "";
  let secretRef = id.replace(/-/g, "_").toUpperCase() + "_API_KEY";
  let secretValue: string | undefined;

  const acceptSecret = (rawValue: string): void => {
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    const environmentReference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
    if (environmentReference) {
      secretRef = environmentReference[1] as string;
      return;
    }
    if (/^(?:<[^>]+>|your[-_ ]|replace[-_ ]|api[-_ ]?key$)/i.test(value)) return;
    if (value && value !== "***") secretValue = value;
  };

  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "authorization") {
      const bearer = /^bearer\s+(.+)$/i.exec(value);
      authKind = "bearer";
      authName = "";
      if (bearer) acceptSecret(bearer[1] as string);
      continue;
    }
    if (["x-api-key", "api-key"].includes(normalizedName)) {
      authKind = "header";
      authName = name;
      acceptSecret(value);
      continue;
    }
    if (!["content-type", "accept", "content-length"].includes(normalizedName)) {
      staticHeaders[name] = value;
    }
  }

  const sensitiveQueryNames = new Set([
    "access_token",
    "api_key",
    "apikey",
    "key",
    "token",
  ]);
  const queryParameters: Record<string, string> = {};
  const safeRequestUrl = new URL(requestUrl);
  for (const [name, value] of requestUrl.searchParams.entries()) {
    if (sensitiveQueryNames.has(name.toLowerCase())) {
      authKind = "query";
      authName = name;
      acceptSecret(value);
      safeRequestUrl.searchParams.delete(name);
    } else {
      queryParameters[name] = value;
    }
  }

  let basePath = pathname;
  for (const endpoint of [
    /\/chat\/completions$/i,
    /\/responses$/i,
    /\/messages$/i,
    /\/models$/i,
  ]) {
    if (endpoint.test(basePath)) {
      basePath = basePath.replace(endpoint, "");
      break;
    }
  }
  const base = new URL(requestUrl.origin);
  base.pathname = basePath || "/";
  const baseUrl = base.toString().replace(/\/+$/, "");

  let modelId: string | undefined;
  const escapedJsonModel = /\\?["']model\\?["']\s*:\s*\\?["']([^"'\\]+)\\?["']/i.exec(
    input,
  );
  const looseModel = /\bmodel\s*[:=]\s*["']?([A-Za-z0-9._:/-]+)/i.exec(input);
  if (escapedJsonModel) modelId = escapedJsonModel[1]?.trim();
  else if (looseModel) modelId = looseModel[1]?.trim();
  else modelId = requestUrl.searchParams.get("model")?.trim() || undefined;

  return {
    requestUrl: safeRequestUrl.href,
    baseUrl,
    id,
    displayName,
    apiType,
    adapterId,
    authKind,
    authName,
    secretRef,
    ...(secretValue === undefined ? {} : { secretValue }),
    staticHeaders,
    queryParameters,
    manualModelIds: modelId ? [modelId] : [],
  };
}
