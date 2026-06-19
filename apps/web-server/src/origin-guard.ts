// Origin/Host perimeter check (docs/spec/12 NF-SEC-3; DECISIONS D4/D9).
//
// Auth is descoped for v1 (NF-SEC-2), but the service still defends the loopback
// perimeter against cross-site / DNS-rebinding access: every WebSocket upgrade AND
// every HTTP side-channel request MUST have an allowlisted `Origin`/`Host`, rejected
// **before any `GitEngine` method runs** (NF-SEC-3). This is enforced as ONE global
// `HttpRouter.serve` middleware — the platform-node `serve` applies the same
// middleware to both the request handler and the upgrade handler, so the single guard
// below covers the static routes, the side-channel, and the `/rpc` WS upgrade.

import { Http } from "@cbranch/rpc-contract/effect-rpc-adapter";
import { Effect } from "effect";

import { normalizeHostname } from "./config";

/** Extract the lowercased hostname from a `Host` (`h:p`) or `Origin` (URL) header. */
const hostnameOf = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return normalizeHostname(url.hostname);
  } catch {
    return undefined;
  }
};

/**
 * Decide whether a request's `Origin`/`Host` headers are allowlisted (NF-SEC-3). The
 * `Host` MUST be present and allowed; `Origin`, when present, MUST also be allowed
 * (a same-origin GET or a Node WS client may legitimately omit it, so a missing
 * `Origin` is permitted — a forged one is not). Pure + header-only, so it is unit
 * tested without a live server.
 */
export const isAllowedRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  allowedHostnames: ReadonlySet<string>,
): boolean => {
  const host = hostnameOf(headers["host"]);
  if (host === undefined || !allowedHostnames.has(host)) return false;
  const origin = headers["origin"];
  if (origin === undefined || origin === "") return true;
  const originHost = hostnameOf(origin);
  return originHost !== undefined && allowedHostnames.has(originHost);
};

type HttpResponse = Http.HttpServerResponse.HttpServerResponse;
type HttpRequest = Http.HttpServerRequest.HttpServerRequest;

/**
 * Build the global perimeter middleware. A rejected request short-circuits with a
 * fresh `403` WITHOUT yielding the inner app, so no route handler (and thus no
 * `GitEngine` call) ever runs for it (NF-SEC-3). Returning the 403 without invoking
 * the inner effect is the supported short-circuit form for `HttpRouter.serve`
 * middleware (the "response not reflected" caveat only applies after `inner` runs).
 *
 * Typed as a generic that preserves the wrapped app's error/requirement channels (and
 * only adds a `HttpServerRequest` read), so `HttpRouter.serve` infers an exact residual
 * context instead of the `any` the broad `HttpMiddleware` interface would introduce.
 */
export const makeOriginGuard =
  (allowedHostnames: ReadonlySet<string>) =>
  <E, R>(httpEffect: Effect.Effect<HttpResponse, E, R>): Effect.Effect<HttpResponse, E, R | HttpRequest> =>
    Effect.gen(function* () {
      const request = yield* Http.HttpServerRequest.HttpServerRequest;
      if (!isAllowedRequest(request.headers, allowedHostnames)) {
        return Http.HttpServerResponse.text("forbidden: origin/host not in allowlist", { status: 403 });
      }
      return yield* httpEffect;
    });
