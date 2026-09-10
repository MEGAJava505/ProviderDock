import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { ProviderDockApplication } from "../application/provider-dock-application.js";
import type { FallbackNotification } from "../core/fallback/fallback-session-router.js";
import { providerErrorGuidance } from "../core/errors/provider-error.js";
import type { ProviderHealthRecord } from "../core/health/provider-health-repository.js";
import { portalAdapterIdForSite, portalConnectionSchema } from "../core/portals/portal-types.js";
import {
  providerDashboardCss,
  providerDashboardHtml,
  providerDashboardJavaScript,
} from "./provider-dashboard-page.js";
import { pickProjectDirectory } from "./project-directory-picker.js";
import { buildModelStorefront } from "./model-storefront.js";
import { isLoopbackPortAllowed } from "../core/http/loopback-port.js";
import { CookieImportError, cookieHeaderForSite, parseCookieEditorExport } from "./cookie-import.js";

const loopbackHost = "127.0.0.1" as const;
const defaultBodyLimitBytes = 512 * 1024;
const maximumPortalImportBytes = 2 * 1024 * 1024;
const maximumLaunchRecords = 100;

export type ProviderDashboardApplication = Pick<
  ProviderDockApplication,
  | "listProviders"
  | "setProvider"
  | "setProviderModelEnabled"
  | "listProviderPortals"
  | "listPortalAdapters"
  | "setProviderPortal"
  | "refreshProviderPortal"
  | "removeProviderPortal"
  | "refreshDueProviderPortals"
  | "removeProvider"
  | "probeProvider"
  | "probeDueProviders"
  | "diagnoseProvider"
  | "listProviderHealth"
  | "listLogicalModels"
  | "listPromptProfiles"
  | "listProjectProfiles"
  | "listProviderPlugins"
  | "summarizeUsage"
  | "listUsage"
  | "setSecret"
  | "listSecretReferences"
  | "removeSecret"
  | "setLogicalModel"
  | "removeLogicalModel"
  | "setPromptProfile"
  | "removePromptProfile"
  | "setProjectProfile"
  | "removeProjectProfile"
  | "launchCodex"
  | "launchCodexLogicalModel"
  | "launchCodexPromptProfile"
  | "launchCodexProjectProfile"
  | "launchClaude"
  | "launchClaudeLogicalModel"
  | "launchClaudePromptProfile"
  | "launchClaudeProjectProfile"
  | "launchProviderAutomatic"
  | "launchLogicalModelAutomatic"
  | "launchPromptProfileAutomatic"
  | "launchProjectProfileAutomatic"
>;

export interface ProviderDashboardServerOptions {
  readonly application: ProviderDashboardApplication;
  /** Fixed port for explicit operator configuration/tests; zero selects a random port. */
  readonly port?: number;
  /** Overridable for deterministic tests. Never expose a predictable production token. */
  readonly sessionToken?: string;
  readonly requestBodyLimitBytes?: number;
  /** Metadata-only background probe cadence; zero disables the monitor. */
  readonly healthMonitorIntervalMs?: number;
  readonly now?: () => Date;
  readonly onUnexpectedError?: (error: unknown) => void;
  /** Native folder chooser override for tests or alternate desktop hosts. */
  readonly pickDirectory?: () => Promise<string | undefined>;
}

export interface ProviderDashboardAddress {
  readonly host: typeof loopbackHost;
  readonly port: number;
  readonly url: string;
}

const doctorRequestSchema = z
  .object({
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(1),
    modelId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const secretWriteRequestSchema = z
  .object({
    value: z.string().min(1).max(256 * 1024),
  })
  .strict();

const portalImportRequestSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  authKind: z.enum(["cookie", "bearer"]).default("cookie"),
  raw: z.string().min(1).max(maximumPortalImportBytes),
  siteUrl: z.string().url().max(2_048),
  adapterId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default("new-api"),
  userId: z.number().int().positive().safe().optional(),
  autoRefresh: z.boolean().default(true),
  refreshIntervalMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
}).strict();

const projectProfileDeleteRequestSchema = z
  .object({
    projectDirectory: z.string().trim().min(1).max(4_096),
  })
  .strict();

const projectProfileWriteRequestSchema = projectProfileDeleteRequestSchema.extend({
  promptProfileId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
});

const launchRequestSchema = z
  .object({
    client: z.enum(["auto", "codex", "claude-code"]).default("auto"),
    projectDirectory: z.string().trim().min(1).max(4_096),
    providerId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .optional(),
    modelId: z.string().trim().min(1).max(256).optional(),
    logicalModelId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .optional(),
    promptProfileId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.providerId === undefined) !== (request.modelId === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "providerId and modelId must be supplied together.",
      });
    }
    const selectors = [
      request.providerId === undefined ? undefined : "provider",
      request.logicalModelId === undefined ? undefined : "logical-model",
      request.promptProfileId === undefined ? undefined : "prompt-profile",
    ].filter((value) => value !== undefined);
    if (selectors.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose exactly one provider, logical model, or prompt profile selector.",
      });
    }
  });

export type ProviderDashboardLaunchRequest = z.infer<typeof launchRequestSchema>;

export type ProviderDashboardLaunchStatus = "STARTING" | "RUNNING" | "EXITED" | "FAILED";

export interface ProviderDashboardLaunchRecord {
  readonly id: string;
  readonly status: ProviderDashboardLaunchStatus;
  readonly request: ProviderDashboardLaunchRequest;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly resolvedClient?: "codex" | "claude-code";
  readonly exitSummary?: string;
  readonly errorMessage?: string;
  readonly fallbacks: readonly FallbackNotification[];
}

interface MutableLaunchRecord {
  id: string;
  status: ProviderDashboardLaunchStatus;
  request: ProviderDashboardLaunchRequest;
  startedAt: string;
  finishedAt?: string;
  resolvedClient?: "codex" | "claude-code";
  exitSummary?: string;
  errorMessage?: string;
  fallbacks: FallbackNotification[];
}

/**
 * Local control surface over ProviderDock's existing application service.
 *
 * The server is intentionally bound to IPv4 loopback, uses a random
 * unguessable path for every process, rejects cross-site mutations, and never
 * accepts or returns provider secret values.
 */
export class ProviderDashboardServer {
  private readonly application: ProviderDashboardApplication;
  private readonly configuredPort: number;
  private readonly sessionToken: string;
  private readonly requestBodyLimitBytes: number;
  private readonly healthMonitorIntervalMs: number;
  private readonly now: () => Date;
  private readonly onUnexpectedError: ((error: unknown) => void) | undefined;
  private readonly pickDirectory: () => Promise<string | undefined>;
  private readonly launches = new Map<string, MutableLaunchRecord>();
  private server: Server | undefined;
  private startTask: Promise<ProviderDashboardAddress> | undefined;
  private stopTask: Promise<void> | undefined;
  private healthMonitorTimer: NodeJS.Timeout | undefined;
  private healthMonitorTask: Promise<void> | undefined;

  constructor(options: ProviderDashboardServerOptions) {
    this.application = options.application;
    this.configuredPort = normalizePort(options.port ?? 0);
    this.sessionToken = normalizeSessionToken(
      options.sessionToken ?? randomBytes(24).toString("hex"),
    );
    this.requestBodyLimitBytes = positiveSafeInteger(
      options.requestBodyLimitBytes ?? defaultBodyLimitBytes,
      "requestBodyLimitBytes",
    );
    this.healthMonitorIntervalMs = nonnegativeSafeInteger(
      options.healthMonitorIntervalMs ?? 30_000,
      "healthMonitorIntervalMs",
    );
    this.now = options.now ?? (() => new Date());
    this.onUnexpectedError = options.onUnexpectedError;
    this.pickDirectory = options.pickDirectory ?? pickProjectDirectory;
  }

  start(): Promise<ProviderDashboardAddress> {
    if (this.server?.listening) return Promise.resolve(this.address());
    if (this.startTask !== undefined) return this.startTask;
    if (this.stopTask !== undefined) return this.stopTask.then(() => this.start());
    this.startTask = this.listen().finally(() => {
      this.startTask = undefined;
    });
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask !== undefined) return this.stopTask;
    this.stopTask = this.close().finally(() => {
      this.stopTask = undefined;
    });
    return this.stopTask;
  }

  address(): ProviderDashboardAddress {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("Provider dashboard is not running.");
    }
    return createDashboardAddress(address, this.sessionToken);
  }

  listLaunches(): readonly ProviderDashboardLaunchRecord[] {
    return [...this.launches.values()]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(copyLaunchRecord);
  }

  private async listen(): Promise<ProviderDashboardAddress> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        this.handleRequestError(response, error);
      });
    });
    server.on("clientError", (_error, socket) => {
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      }
    });
    this.server = server;

    try {
      const attempts = this.configuredPort === 0 ? 32 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await listenServer(server, this.configuredPort);
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Provider dashboard did not receive a TCP address.");
        }
        if (isDashboardPortAllowed(address.port)) {
          this.startHealthMonitor();
          return createDashboardAddress(address, this.sessionToken);
        }
        await closeListeningServer(server);
      }
      throw new Error("Unable to allocate a browser-compatible dashboard port.");
    } catch (error) {
      this.server = undefined;
      server.closeAllConnections?.();
      throw error;
    }
  }

  private async close(): Promise<void> {
    if (this.healthMonitorTimer !== undefined) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = undefined;
    }
    if (this.startTask !== undefined && !this.server?.listening) {
      await this.startTask.catch(() => undefined);
    }
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections?.();
    });
    await this.healthMonitorTask?.catch(() => undefined);
  }

  private startHealthMonitor(): void {
    if (this.healthMonitorIntervalMs === 0 || this.healthMonitorTimer !== undefined) {
      return;
    }
    void this.runDueProbes();
    this.healthMonitorTimer = setInterval(() => {
      void this.runDueProbes();
    }, this.healthMonitorIntervalMs);
    this.healthMonitorTimer.unref?.();
  }

  private runDueProbes(): Promise<void> {
    if (this.healthMonitorTask !== undefined) return this.healthMonitorTask;
    this.healthMonitorTask = Promise.allSettled([
      this.application.probeDueProviders(this.now()),
      this.application.refreshDueProviderPortals(),
    ])
      .then((results) => {
        for (const result of results) if (result.status === "rejected") throw result.reason;
      })
      .catch((error: unknown) => {
        try {
          this.onUnexpectedError?.(error);
        } catch {
          // Monitoring failures and observers must not terminate the dashboard.
        }
      })
      .finally(() => {
        this.healthMonitorTask = undefined;
      });
    return this.healthMonitorTask;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const activeAddress = this.address();
    if (!hasExpectedHost(request, activeAddress)) {
      sendJson(response, 400, { code: "INVALID_HOST", message: "Invalid dashboard host." });
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${loopbackHost}`);
    const rootPath = `/${this.sessionToken}`;
    if (requestUrl.pathname === rootPath) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }
      response.writeHead(308, {
        location: `${rootPath}/`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end();
      return;
    }
    if (!requestUrl.pathname.startsWith(`${rootPath}/`)) {
      notFound(response);
      return;
    }
    const path = requestUrl.pathname.slice(rootPath.length);

    if (request.method !== "GET" && !isSameOriginMutation(request, activeAddress)) {
      sendJson(response, 403, {
        code: "CROSS_ORIGIN_BLOCKED",
        message: "Cross-origin dashboard mutation was blocked.",
      });
      return;
    }

    if (request.method === "GET" && path === "/") {
      sendAsset(response, "text/html; charset=utf-8", providerDashboardHtml);
      return;
    }
    if (request.method === "GET" && path === "/app.css") {
      sendAsset(response, "text/css; charset=utf-8", providerDashboardCss);
      return;
    }
    if (request.method === "GET" && path === "/app.js") {
      sendAsset(
        response,
        "text/javascript; charset=utf-8",
        providerDashboardJavaScript,
      );
      return;
    }
    if (request.method === "GET" && path === "/api/snapshot") {
      sendJson(response, 200, await this.createSnapshot());
      return;
    }
    if (request.method === "GET" && path === "/api/launches") {
      sendJson(response, 200, { launches: this.listLaunches() });
      return;
    }
    if (request.method === "POST" && path === "/api/directories/pick") {
      const projectDirectory = await this.pickDirectory();
      sendJson(response, 200, {
        selected: projectDirectory !== undefined,
        ...(projectDirectory === undefined ? {} : { projectDirectory }),
      });
      return;
    }
    const modelControl = /^\/api\/providers\/([^/]+)\/model-state$/.exec(path);
    if (modelControl) {
      if (request.method !== "PUT") { methodNotAllowed(response, "PUT"); return; }
      const input = z.object({ modelId: z.string().trim().min(1).max(256), enabled: z.boolean() }).strict()
        .parse(await readJsonBody(request, this.requestBodyLimitBytes));
      const provider = await this.application.setProviderModelEnabled(decodePathSegment(modelControl[1]!), input.modelId, input.enabled);
      sendJson(response, 200, { provider });
      return;
    }
    if (request.method === "POST" && path === "/api/providers") {
      const profile = await this.application.setProvider(
        await readJsonBody(request, this.requestBodyLimitBytes),
      );
      sendJson(response, 200, { provider: profile });
      return;
    }
    if (request.method === "POST" && path === "/api/logical-models") {
      const logicalModel = await this.application.setLogicalModel(
        await readJsonBody(request, this.requestBodyLimitBytes),
      );
      sendJson(response, 200, { logicalModel });
      return;
    }
    if (request.method === "POST" && path === "/api/prompt-profiles") {
      const promptProfile = await this.application.setPromptProfile(
        await readJsonBody(request, this.requestBodyLimitBytes),
      );
      sendJson(response, 200, { promptProfile });
      return;
    }
    if (request.method === "POST" && path === "/api/project-profiles") {
      const projectProfile = await this.application.setProjectProfile(
        projectProfileWriteRequestSchema.parse(
          await readJsonBody(request, this.requestBodyLimitBytes),
        ),
      );
      sendJson(response, 200, { projectProfile });
      return;
    }
    if (request.method === "DELETE" && path === "/api/project-profiles") {
      const input = projectProfileDeleteRequestSchema.parse(
        await readJsonBody(request, this.requestBodyLimitBytes),
      );
      await this.application.removeProjectProfile(input.projectDirectory);
      sendJson(response, 200, { removed: true });
      return;
    }
    if (request.method === "POST" && path === "/api/launches") {
      const launch = this.startLaunch(
        launchRequestSchema.parse(
          await readJsonBody(request, this.requestBodyLimitBytes),
        ),
      );
      sendJson(response, 202, { launch });
      return;
    }

    if (path === "/api/portals/import" || path === "/api/portals/import-cookies") {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }
      const input = portalImportRequestSchema.parse(await readJsonBody(
        request,
        Math.max(this.requestBodyLimitBytes, maximumPortalImportBytes + 64 * 1024),
      ));
      const providers = await this.application.listProviders();
      const provider = providers.find((item) => item.id === input.providerId);
      if (!provider) {
        throw new DashboardRequestError(404, "PROVIDER_NOT_FOUND", "Провайдер не найден.");
      }
      const adapterId = portalAdapterIdForSite(input.siteUrl, input.adapterId);
      const adapters = await this.application.listPortalAdapters();
      if (!adapters.some((adapter) => adapter.id === adapterId)) {
        throw new DashboardRequestError(
          400,
          "PORTAL_ADAPTER_NOT_FOUND",
          "Выбранный адаптер кабинета недоступен.",
        );
      }
      const previous = (await this.application.listProviderPortals())
        .find((record) => record.connection.providerId === provider.id);
      const baseConnection = portalConnectionSchema.parse({
        providerId: provider.id,
        siteUrl: input.siteUrl,
        adapterId,
        auth: { kind: "none" },
        autoRefresh: input.autoRefresh,
        refreshIntervalMs: input.refreshIntervalMs,
      });
      const sameSite = previous?.connection.siteUrl === baseConnection.siteUrl;
      const connection = portalConnectionSchema.parse({
        ...baseConnection,
        ...(input.userId !== undefined
          ? { userId: input.userId }
          : sameSite && previous?.connection.userId !== undefined
            ? { userId: previous.connection.userId }
            : {}),
        ...(sameSite && previous?.connection.userAgent
          ? { userAgent: previous.connection.userAgent }
          : {}),
      });
      const site = new URL(connection.siteUrl);
      let secretValue: string;
      if (input.authKind === "cookie") {
        let rows;
        try {
          rows = parseCookieEditorExport(input.raw);
        } catch (error) {
          const detail = error instanceof CookieImportError ? " " + error.message : "";
          throw new DashboardRequestError(
            400,
            "INVALID_COOKIE_EXPORT",
            "Не удалось прочитать экспорт Cookie-Editor." + detail,
          );
        }
        try {
          secretValue = cookieHeaderForSite(rows, site.hostname, {
            protocol: site.protocol as "http:" | "https:",
            requestPaths: [
              "/api/status",
              "/api/user/self",
              "/api/user/checkin",
              "/api/pricing",
              "/api/perf-metrics/summary",
              "/api/portal/api-keys",
              "/en/api-keys",
              "/dashboard",
              "/models-list",
            ],
          }) ?? "";
        } catch (error) {
          const detail = error instanceof CookieImportError ? " " + error.message : "";
          throw new DashboardRequestError(
            400,
            "INVALID_COOKIE_EXPORT",
            "Cookies нельзя безопасно импортировать." + detail,
          );
        }
        if (!secretValue) {
          throw new DashboardRequestError(
            400,
            "NO_MATCHING_COOKIES",
            "В экспорте нет действующих cookies для " + site.hostname + ".",
          );
        }
      } else {
        secretValue = input.raw.trim().replace(/^Bearer\s+/i, "").trim();
        if (!secretValue || /[\r\n]/.test(secretValue)) {
          throw new DashboardRequestError(
            400,
            "INVALID_ACCESS_TOKEN",
            "Access Token должен быть одной непустой строкой.",
          );
        }
      }
      const sameAuthKind = sameSite && previous?.connection.auth.kind === input.authKind;
      const suffix = input.authKind === "cookie" ? "PORTAL_COOKIE" : "PORTAL_ACCESS_TOKEN";
      const reference = sameAuthKind && previous?.connection.auth.kind !== "none"
        ? previous.connection.auth.secretRef
        : provider.id.replaceAll("-", "_").toUpperCase() + "_" + suffix + "_" + randomUUID().slice(0, 8);
      await this.application.setSecret(reference, secretValue);
      const configured = await this.application.setProviderPortal({
        ...connection,
        auth: { kind: input.authKind, secretRef: reference },
      });
      const refreshed = await this.application.refreshProviderPortal(provider.id).catch(() => undefined);
      sendJson(response, 200, {
        imported: [provider.id],
        portal: refreshed ?? configured,
        refreshed: refreshed !== undefined,
      });
      return;
    }
    const portalAction = /^\/api\/providers\/([^/]+)\/portal(\/refresh)?$/.exec(path);
    if (portalAction) {
      const providerId = decodePathSegment(portalAction[1] as string);
      if (request.method === "PUT" && !portalAction[2]) {
        const input = z.record(z.unknown()).parse(await readJsonBody(request, this.requestBodyLimitBytes));
        sendJson(response, 200, { portal: await this.application.setProviderPortal({ ...input, providerId }) });
        return;
      }
      if (request.method === "POST" && portalAction[2]) {
        sendJson(response, 200, { portal: await this.application.refreshProviderPortal(providerId) });
        return;
      }
      if (request.method === "DELETE" && !portalAction[2]) {
        await this.application.removeProviderPortal(providerId);
        sendJson(response, 200, { removed: true });
        return;
      }
    }

    const providerAction = /^\/api\/providers\/([^/]+)\/(probe|doctor)$/.exec(path);
    if (providerAction !== null && request.method === "POST") {
      const providerId = decodePathSegment(providerAction[1] as string);
      if (providerAction[2] === "probe") {
        sendJson(response, 200, {
          result: await this.application.probeProvider(providerId),
        });
      } else {
        const doctorRequest = doctorRequestSchema.parse(
          await readJsonBody(request, this.requestBodyLimitBytes, {}),
        );
        sendJson(response, 200, {
          report: await this.application.diagnoseProvider(providerId, {
            level: doctorRequest.level,
            ...(doctorRequest.modelId === undefined
              ? {}
              : { modelId: doctorRequest.modelId }),
          }),
        });
      }
      return;
    }

    const providerResource = /^\/api\/providers\/([^/]+)$/.exec(path);
    if (providerResource !== null && request.method === "DELETE") {
      await this.application.removeProvider(
        decodePathSegment(providerResource[1] as string),
      );
      sendJson(response, 200, { removed: true });
      return;
    }

    const logicalModelResource = /^\/api\/logical-models\/([^/]+)$/.exec(path);
    if (logicalModelResource !== null && request.method === "DELETE") {
      await this.application.removeLogicalModel(
        decodePathSegment(logicalModelResource[1] as string),
      );
      sendJson(response, 200, { removed: true });
      return;
    }

    const promptProfileResource = /^\/api\/prompt-profiles\/([^/]+)$/.exec(path);
    if (promptProfileResource !== null && request.method === "DELETE") {
      await this.application.removePromptProfile(
        decodePathSegment(promptProfileResource[1] as string),
      );
      sendJson(response, 200, { removed: true });
      return;
    }

    const secretResource = /^\/api\/secrets\/([^/]+)$/.exec(path);
    if (secretResource !== null && request.method === "PUT") {
      const reference = decodePathSegment(secretResource[1] as string);
      const input = secretWriteRequestSchema.parse(
        await readJsonBody(request, this.requestBodyLimitBytes),
      );
      await this.application.setSecret(reference, input.value);
      sendJson(response, 200, { stored: true, reference });
      return;
    }
    if (secretResource !== null && request.method === "DELETE") {
      const reference = decodePathSegment(secretResource[1] as string);
      const removed = await this.application.removeSecret(reference);
      sendJson(response, 200, { removed, reference });
      return;
    }

    if (
      providerAction !== null ||
      providerResource !== null ||
      logicalModelResource !== null ||
      promptProfileResource !== null ||
      secretResource !== null ||
      path === "/api/directories/pick" ||
      path === "/api/providers" ||
      path === "/api/launches" ||
      path === "/api/logical-models" ||
      path === "/api/prompt-profiles" ||
      path === "/api/project-profiles"
    ) {
      methodNotAllowed(
        response,
        path === "/api/launches"
          ? "GET, POST"
          : path === "/api/directories/pick"
            ? "POST"
            : secretResource !== null
              ? "PUT, DELETE"
              : path === "/api/project-profiles"
                ? "POST, DELETE"
                : "POST, DELETE",
      );
      return;
    }
    notFound(response);
  }

  private async createSnapshot(): Promise<Record<string, unknown>> {
    const [
      providers,
      health,
      logicalModels,
      promptProfiles,
      projectProfiles,
      usage,
      secretVault,
      portals,
      usageEvents,
    ] = await Promise.all([
      this.application.listProviders(),
      this.application.listProviderHealth(),
      this.application.listLogicalModels(),
      this.application.listPromptProfiles(),
      this.application.listProjectProfiles(),
      this.application.summarizeUsage(),
      this.createSecretVaultSnapshot(),
      this.application.listProviderPortals(),
      this.application.listUsage(),
    ]);
    return {
      version: 1,
      generatedAt: this.now().toISOString(),
      providers,
      health: health.map(enrichHealthRecord),
      storefront: buildModelStorefront(providers, health, this.now(), portals),
      logicalModels,
      promptProfiles,
      projectProfiles,
      providerPlugins: this.application.listProviderPlugins(),
      usage,
      usageEvents,
      secretVault,
      portals,
      portalAdapters: this.application.listPortalAdapters(),
    };
  }

  private async createSecretVaultSnapshot(): Promise<{
    readonly available: boolean;
    readonly references: readonly string[];
    readonly errorMessage?: string;
  }> {
    try {
      return {
        available: true,
        references: await this.application.listSecretReferences(),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        ["SecretVaultUnavailableError", "SecretProtectionError"].includes(
          error.name,
        )
      ) {
        return {
          available: false,
          references: [],
          errorMessage: error.message,
        };
      }
      throw error;
    }
  }

  private startLaunch(
    request: ProviderDashboardLaunchRequest,
  ): ProviderDashboardLaunchRecord {
    this.pruneLaunches();
    const launch: MutableLaunchRecord = {
      id: randomUUID(),
      status: "STARTING",
      request,
      startedAt: this.now().toISOString(),
      fallbacks: [],
    };
    this.launches.set(launch.id, launch);
    const onFallback = (notification: FallbackNotification): void => {
      launch.fallbacks.push(notification);
    };
    const onStarted = (client: "codex" | "claude-code"): void => {
      launch.status = "RUNNING";
      launch.resolvedClient = client;
    };
    void this.performLaunch(request, onFallback, onStarted).then(
      ({ client, exitCode, signal }) => {
        launch.status = "EXITED";
        launch.resolvedClient = client;
        launch.finishedAt = this.now().toISOString();
        launch.exitSummary =
          signal === null
            ? `Exited with code ${exitCode === null ? "unknown" : exitCode}.`
            : `Exited after signal ${signal}.`;
      },
      (error: unknown) => {
        launch.status = "FAILED";
        launch.finishedAt = this.now().toISOString();
        launch.errorMessage = publicErrorMessage(error);
      },
    );
    return copyLaunchRecord(launch);
  }

  private async performLaunch(
    request: ProviderDashboardLaunchRequest,
    onFallback: (notification: FallbackNotification) => void,
    onStarted: (client: "codex" | "claude-code") => void,
  ): Promise<{
    readonly client: "codex" | "claude-code";
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }> {
    const shared = {
      projectDirectory: request.projectDirectory,
      onFallback,
      onStarted,
    };
    if (request.client === "auto") {
      if (request.providerId !== undefined && request.modelId !== undefined) {
        const result = await this.application.launchProviderAutomatic({
          ...shared,
          providerId: request.providerId,
          modelId: request.modelId,
        });
        return { client: result.client, ...result.exit };
      }
      if (request.logicalModelId !== undefined) {
        const result = await this.application.launchLogicalModelAutomatic({
          ...shared,
          logicalModelId: request.logicalModelId,
        });
        return { client: result.client, ...result.exit };
      }
      if (request.promptProfileId !== undefined) {
        const result = await this.application.launchPromptProfileAutomatic({
          ...shared,
          promptProfileId: request.promptProfileId,
        });
        return { client: result.client, ...result.exit };
      }
      const result = await this.application.launchProjectProfileAutomatic(shared);
      return { client: result.client, ...result.exit };
    }

    if (request.client === "codex") {
      const exit =
        request.providerId !== undefined && request.modelId !== undefined
          ? await this.application.launchCodex({
              ...shared,
              providerId: request.providerId,
              modelId: request.modelId,
              route: { kind: "auto" },
            })
          : request.logicalModelId !== undefined
            ? await this.application.launchCodexLogicalModel({
                ...shared,
                logicalModelId: request.logicalModelId,
                route: { kind: "auto" },
              })
            : request.promptProfileId !== undefined
              ? await this.application.launchCodexPromptProfile({
                  ...shared,
                  promptProfileId: request.promptProfileId,
                })
              : await this.application.launchCodexProjectProfile(shared);
      return { client: "codex", ...exit };
    }

    const exit =
      request.providerId !== undefined && request.modelId !== undefined
        ? await this.application.launchClaude({
            ...shared,
            providerId: request.providerId,
            modelId: request.modelId,
          })
        : request.logicalModelId !== undefined
          ? await this.application.launchClaudeLogicalModel({
              ...shared,
              logicalModelId: request.logicalModelId,
            })
          : request.promptProfileId !== undefined
            ? await this.application.launchClaudePromptProfile({
                ...shared,
                promptProfileId: request.promptProfileId,
              })
            : await this.application.launchClaudeProjectProfile(shared);
    return { client: "claude-code", ...exit };
  }

  private pruneLaunches(): void {
    if (this.launches.size < maximumLaunchRecords) return;
    const terminal = [...this.launches.values()]
      .filter((launch) => !["STARTING", "RUNNING"].includes(launch.status))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    for (const launch of terminal.slice(
      0,
      Math.max(1, this.launches.size - maximumLaunchRecords + 1),
    )) {
      this.launches.delete(launch.id);
    }
  }

  private handleRequestError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof DashboardRequestError) {
      sendJson(response, error.status, { code: error.code, message: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      sendJson(response, 400, {
        code: "INVALID_REQUEST",
        message: error.issues.map((issue) => issue.message).join("; "),
      });
      return;
    }
    const namedStatus = statusForApplicationError(error);
    if (namedStatus !== undefined) {
      sendJson(response, namedStatus, {
        code: error instanceof Error ? error.name : "REQUEST_FAILED",
        message: publicErrorMessage(error),
      });
      return;
    }
    this.onUnexpectedError?.(error);
    sendJson(response, 500, {
      code: "INTERNAL_ERROR",
      message: "Unexpected dashboard failure.",
    });
  }
}

class DashboardRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DashboardRequestError";
  }
}

function copyLaunchRecord(
  launch: MutableLaunchRecord,
): ProviderDashboardLaunchRecord {
  return {
    id: launch.id,
    status: launch.status,
    request: launch.request,
    startedAt: launch.startedAt,
    ...(launch.finishedAt === undefined ? {} : { finishedAt: launch.finishedAt }),
    ...(launch.resolvedClient === undefined
      ? {}
      : { resolvedClient: launch.resolvedClient }),
    ...(launch.exitSummary === undefined
      ? {}
      : { exitSummary: launch.exitSummary }),
    ...(launch.errorMessage === undefined
      ? {}
      : { errorMessage: launch.errorMessage }),
    fallbacks: [...launch.fallbacks],
  };
}

function createDashboardAddress(
  address: AddressInfo,
  sessionToken: string,
): ProviderDashboardAddress {
  return {
    host: loopbackHost,
    port: address.port,
    url: `http://${loopbackHost}:${address.port}/${sessionToken}/`,
  };
}

function hasExpectedHost(
  request: IncomingMessage,
  address: ProviderDashboardAddress,
): boolean {
  return request.headers.host === `${address.host}:${address.port}`;
}

function isSameOriginMutation(
  request: IncomingMessage,
  address: ProviderDashboardAddress,
): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    typeof fetchSite === "string" &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    return false;
  }
  const origin = request.headers.origin;
  return (
    origin === undefined ||
    origin === `http://${address.host}:${address.port}`
  );
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
  emptyValue?: unknown,
): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (
    contentType !== undefined &&
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new DashboardRequestError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Dashboard request body must use application/json.",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) {
      throw new DashboardRequestError(
        413,
        "BODY_TOO_LARGE",
        `Dashboard request body exceeds ${maximumBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  if (total === 0 && emptyValue !== undefined) return emptyValue;
  if (total === 0) {
    throw new DashboardRequestError(400, "EMPTY_BODY", "A JSON request body is required.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DashboardRequestError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
}

function sendAsset(
  response: ServerResponse,
  contentType: string,
  body: string,
): void {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(serialized);
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  sendJson(response, 405, {
    code: "METHOD_NOT_ALLOWED",
    message: "Method not allowed.",
  });
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { code: "NOT_FOUND", message: "Not found." });
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DashboardRequestError(400, "INVALID_PATH", "Invalid URL path encoding.");
  }
}

function normalizePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError("port must be a safe integer between 0 and 65535.");
  }
  if (value !== 0 && !isDashboardPortAllowed(value)) {
    throw new TypeError(`Port ${value} is blocked by common browsers.`);
  }
  return value;
}

function normalizeSessionToken(value: string): string {
  if (!/^[a-f0-9]{32,128}$/.test(value)) {
    throw new TypeError(
      "sessionToken must contain 32 to 128 lowercase hexadecimal characters.",
    );
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function enrichHealthRecord(record: ProviderHealthRecord): ProviderHealthRecord & {
  readonly errorGuidance?: ReturnType<typeof providerErrorGuidance>;
} {
  const latestRuntime = record.runtimeSignals.reduce<
    ProviderHealthRecord["runtimeSignals"][number] | undefined
  >(
    (latest, signal) =>
      latest === undefined || signal.observedAt > latest.observedAt
        ? signal
        : latest,
    undefined,
  );
  const latestProbe = record.latest?.health;
  const errorType =
    latestRuntime !== undefined &&
    (latestProbe === undefined || latestRuntime.observedAt >= latestProbe.checkedAt)
      ? latestRuntime.errorType
      : latestProbe?.errorType;
  return {
    ...record,
    ...(errorType === undefined
      ? {}
      : { errorGuidance: providerErrorGuidance(errorType) }),
  };
}

function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: loopbackHost, port, exclusive: true });
  });
}

function closeListeningServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function statusForApplicationError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    [
      "ProviderNotFoundError",
      "LogicalModelNotFoundError",
      "PromptProfileNotFoundError",
      "ProjectProfileNotFoundError",
      "ProviderHealthNotFoundError",
    ].includes(error.name)
  ) {
    return 404;
  }
  if (
    [
      "ProviderInUseByLogicalModelError",
      "ProviderInUseByPromptProfileError",
      "LogicalModelInUseByPromptProfileError",
      "PromptProfileInUseByProjectProfileError",
      "ProfileBundleConflictError",
    ].includes(error.name)
  ) {
    return 409;
  }
  if (
    [
      "AutomaticClientResolutionError",
      "PromptProfileLaunchConfigurationError",
      "CodexRuntimeConfigurationError",
      "ClaudeRuntimeConfigurationError",
      "SecretVaultUnavailableError",
      "SecretProtectionError",
      "ProviderRequestError",
      "PortalConfigurationError",
      "ProviderPluginExecutionError",
      "ProviderPluginValidationError",
    ].includes(error.name)
  ) {
    return 400;
  }
  return undefined;
}

function publicErrorMessage(error: unknown): string {
  const status = statusForApplicationError(error);
  if (status !== undefined && error instanceof Error) return error.message;
  return "The requested operation failed unexpectedly.";
}

/** Browser Fetch rejects a small list of historically unsafe ports. */
export function isDashboardPortAllowed(port: number): boolean {
  return isLoopbackPortAllowed(port);
}
