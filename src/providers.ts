import * as core from "@actions/core";
import type { ActionInputs, LlmApiStyle } from "./inputs.js";

export class UnsupportedModelError extends Error {}

/** Same six members as LlmApiStyle in inputs.ts (identical union). */
export type ApiStyle = LlmApiStyle;

/**
 * The body-adapter styles: `auto` is discovered per call by the probe driver
 * (spec §9.5), and "custom-path" (path-only override) resolves to the
 * openai-chat body.
 */
export type ResolvedApiStyle = "openai-chat" | "openai-responses" | "anthropic-messages" | "google-models";

export interface ResolvedEndpoint {
  /** Base URL only; never includes the request path. */
  baseUrl: string;
  /** Request path appended to baseUrl, e.g. "/chat/completions". */
  path: string;
  headers: Record<string, string>;
  /** Resolved API style: the dispatcher in llm.ts picks the adapter by this. */
  apiStyle: ResolvedApiStyle;
}

/**
 * Presets provide base URLs only. Paths are chosen by the resolved API style.
 */
const PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

const CHAT_PATH = "/chat/completions";
const USER_AGENT = "pr-reviewer/1.0";
/** Timeout for each GET {base}/models catalog request. */
const VALIDATE_TIMEOUT_MS = 15_000;

/** Last path segments that identify a non-chat endpoint (path-only misuse). */
const PATH_ONLY_SEGMENTS: ReadonlySet<string> = new Set(["messages", "responses", "models"]);

/**
 * Contract: the caller passes a path that is already normalized (leading "/")
 * and already cleaned (no query or #fragment). This helper only trims trailing
 * slashes and checks whether the LAST segment is exactly messages, responses,
 * or models.
 * `/v1/messages` → true; `/openai/models/chat/completions` → false.
 */
function isPathOnlyNonChat(path: string): boolean {
  const pathname = path.replace(/\/+$/, "");
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return PATH_ONLY_SEGMENTS.has(last);
}

export interface ResolveEndpointOptions {
  llmProvider: ActionInputs["llmProvider"];
  llmBaseUrl: string;
  llmApiStyle: ActionInputs["llmApiStyle"];
  llmPath: string;
  llmModel: string;
  llmApiKey: string;
  prNumber: number | null;
  /**
   * Did the user type this base URL (vs. it being derived, e.g. a preset base
   * or a probe rebuilding a preset-derived base)? Drives the R3 rewrite
   * warning, which must only surface rewrites of USER-SUPPLIED bases. When
   * omitted, falls back to `llmBaseUrl !== ""`.
   */
  userBase?: boolean;
}

/** Default request path for each resolved API style; llm_path overrides it. */
function defaultPathFor(apiStyle: ResolvedApiStyle, model: string): string {
  switch (apiStyle) {
    case "openai-responses":
      return "/responses";
    case "anthropic-messages":
      return "/messages";
    case "google-models":
      return `/models/${model}:generateContent`;
    case "openai-chat":
      return CHAT_PATH;
  }
}

export function resolveEndpoint(o: ResolveEndpointOptions): ResolvedEndpoint {
  const rawBase = o.llmBaseUrl || PRESET_BASE_URLS[o.llmProvider] || "";
  if (rawBase === "") {
    throw new Error(`llm_provider "${o.llmProvider}" requires llm_base_url`);
  }
  const baseUrl = rawBase.replace(/\/+$/, "");

  // custom-path requires an explicit llm_path; other styles default to their own path.
  if (o.llmApiStyle === "custom-path" && o.llmPath === "") {
    throw new Error(`llm_api_style "custom-path" requires llm_path`);
  }

  // Resolve the API style. An explicit v2 style is honored as-is (functional);
  // openai-chat, custom-path and `auto` all resolve to the chat body here.
  // `auto` consults no map (spec §9.5): the probe driver (callWithProbe in
  // llm.ts) discovers the working style from 400/404 errors, building each
  // style's endpoint with buildEndpointForStyle. The chat endpoint resolved
  // for `auto` is the default: first probe style, catalog-check base and host
  // for any llm_path override.
  let apiStyle: ResolvedApiStyle;
  if (o.llmApiStyle === "openai-responses" || o.llmApiStyle === "anthropic-messages" || o.llmApiStyle === "google-models") {
    apiStyle = o.llmApiStyle;
  } else {
    apiStyle = "openai-chat";
  }

  // The google preset base ends in the OpenAI-compat segment (/openai); the
  // native generateContent path hangs off the API root, so drop that segment.
  const effectiveBase =
    apiStyle === "google-models" && baseUrl.endsWith("/openai") ? baseUrl.slice(0, -"/openai".length) : baseUrl;
  // R3: surface the rewrite when it changes a USER-SUPPLIED custom base URL.
  // A probe rebuilding a preset-derived base is not user input: it must not
  // warn (userBase marker; default heuristic: non-empty llm_base_url input).
  const userBase = o.userBase ?? o.llmBaseUrl !== "";
  if (effectiveBase !== baseUrl && userBase) {
    core.warning(
      `llm_base_url "${baseUrl}" rewritten to "${effectiveBase}": google-models needs the API root, not the OpenAI-compat "/openai" suffix`,
    );
  }

  const rawPath = o.llmPath !== "" ? o.llmPath : defaultPathFor(apiStyle, o.llmModel);
  // Normalize (leading slash), then strip query and fragment from the returned
  // path; the path-only guard runs on that same returned path.
  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const path = normalized.split(/[?#]/)[0];
  // Never echo the query or fragment (may carry secrets); name only the parts dropped.
  const strippedParts: string[] = [];
  if (normalized.includes("?")) strippedParts.push("query string");
  if (normalized.includes("#")) strippedParts.push("fragment");
  if (strippedParts.length > 0) {
    core.warning(`llm_path ${strippedParts.join(" and ")} ignored; only the path is used`);
  }
  // Path-only guard: a non-chat path needs a body adapter, which only a v2
  // style provides — with a v2 style active the adapter exists, so it is skipped.
  if (apiStyle === "openai-chat" && isPathOnlyNonChat(path)) {
    const rawClean = rawPath.split(/[?#]/)[0];
    throw new UnsupportedModelError(
      `llm_path "${rawClean}" normalizes to "${path}", which is path-only: it names a non-chat endpoint. ` +
        `llm_path only overrides the path; a non-chat body adapter requires a v2 llm_api_style ` +
        `(openai-responses, anthropic-messages or google-models).`,
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${o.llmApiKey}`,
    "User-Agent": USER_AGENT,
  };
  if (o.llmProvider === "opencode-go" && o.prNumber !== null) {
    headers["x-opencode-session"] = `pr-${o.prNumber}`;
  }

  return { baseUrl: effectiveBase, path, headers, apiStyle };
}

/**
 * Endpoint (baseUrl + path + headers) for ONE API style, used by the probe
 * driver in llm.ts to walk PROBE_ORDER. Thin wrapper over resolveEndpoint with
 * an empty llm_path (the probe always uses each style's default path), so the
 * base rewrite, normalization and header rules stay in one place. `prNumber`
 * preserves the opencode-go session header across probe attempts. `userBase`
 * must be true only when the base came from the user's llm_base_url: the
 * probe's synthetic rebuild of a preset-derived base must not trigger the R3
 * rewrite warning.
 */
export function buildEndpointForStyle(
  provider: string,
  model: string,
  baseUrl: string,
  apiKey: string,
  style: ResolvedApiStyle,
  prNumber: number | null = null,
  userBase = false,
): ResolvedEndpoint {
  return resolveEndpoint({
    llmProvider: provider as ActionInputs["llmProvider"],
    llmBaseUrl: baseUrl,
    llmApiStyle: style,
    llmPath: "",
    llmModel: model,
    llmApiKey: apiKey,
    prNumber,
    userBase,
  });
}

export type CatalogProtocol = "openai" | "anthropic" | "google";

/** Catalog protocol follows the provider, except custom native endpoints. */
export function catalogProtocolFor(provider: string, apiStyle: ResolvedApiStyle): CatalogProtocol {
  if (apiStyle === "google-models" && (provider === "google" || provider === "custom")) return "google";
  if (provider === "anthropic" || (provider === "custom" && apiStyle === "anthropic-messages")) return "anthropic";
  return "openai";
}

function catalogHeaders(protocol: CatalogProtocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (protocol === "google") headers["x-goog-api-key"] = apiKey;
  else if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** An advisory catalog check: only a parsed, non-empty catalog can rule a model absent. */
export async function checkModelListed(
  baseUrl: string,
  model: string,
  apiKey: string,
  protocol: CatalogProtocol,
): Promise<{ status: "listed" | "absent" | "unknown"; detail?: string }> {
  const root = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers = catalogHeaders(protocol, apiKey);
  let url = protocol === "google" ? `${root}?pageSize=1000` : protocol === "anthropic" ? `${root}?limit=1000` : root;
  let sawModels = false;

  for (let page = 0; page < 5; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
    let body: unknown;
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        // Start body cleanup, then abort the request. Do not wait on a stalled stream.
        try {
          void res.body?.cancel().catch(() => undefined);
        } catch {
          // An unavailable body must not turn an advisory check into a failure.
        }
        controller.abort();
        return { status: "unknown", detail: `catalog HTTP ${res.status}` };
      }
      try {
        body = await res.json();
      } catch {
        return { status: "unknown", detail: "catalog returned invalid JSON" };
      }
    } catch {
      return { status: "unknown", detail: controller.signal.aborted ? "catalog request timed out" : "catalog request failed" };
    } finally {
      clearTimeout(timer);
    }

    const catalog = body as Record<string, unknown> | null;
    const entries = protocol === "google" ? catalog?.models : catalog?.data;
    if (!Array.isArray(entries)) return { status: "unknown", detail: "catalog has no models array" };
    if (entries.length > 0) sawModels = true;
    const found = entries.some((entry) => {
      const item = entry as Record<string, unknown> | null;
      const id = protocol === "google" ? item?.name : item?.id;
      return (protocol === "google" && typeof id === "string" ? id.replace(/^models\//, "") : id) === model;
    });
    if (found) return { status: "listed" };

    try {
      if (protocol === "google" && typeof catalog?.nextPageToken === "string" && catalog.nextPageToken !== "") {
        url = `${root}?pageToken=${encodeURIComponent(catalog.nextPageToken)}&pageSize=1000`;
      } else if (protocol === "anthropic" && catalog?.has_more === true && typeof catalog.last_id === "string" && catalog.last_id !== "") {
        url = `${root}?after_id=${encodeURIComponent(catalog.last_id)}&limit=1000`;
      } else {
        break;
      }
    } catch {
      return { status: "unknown", detail: "catalog returned an invalid page cursor" };
    }
  }
  return sawModels ? { status: "absent" } : { status: "unknown", detail: "catalog was empty" };
}
