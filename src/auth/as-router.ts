/**
 * The OAuth 2.1 authorization server (oauth mode), on oidc-provider (ADR-0002):
 * the protected-resource metadata (ours), the library's discovery documents,
 * `/jwks`, `/authorize`, `/token`, `/register` and `/revoke`, and the YNAB
 * sign-in as the library's interaction under /oauth with its rate limit.
 *
 * Every route is a pipeline of named stages, always in this order:
 *
 *   [host-validation]  mounted by http.ts on the whole app, before this router
 *   ...limiters        rate limits, before any body is read: an IP-only
 *                      ip-limiter on /authorize, /token, /register and
 *                      /revoke (#59, #55a), the oauth-leg-limiter on /oauth
 *   bounded-parser     the request-body parser, at AS_MAX_BODY (8kb), with
 *                      OAuth-shaped errors (413 for a body over the limit)
 *   ...slots           route-specific checks (D8): cors-origin (on /token,
 *                      /revoke and /register, ahead of everything that can
 *                      answer), method-check (405 for a method the route
 *                      doesn't serve), then on /authorize the (client_id, IP)
 *                      route-limiter, the bounds (authorize-validation) and
 *                      the open-redirect guard (authorize-guard); on /token
 *                      and /revoke the route limiter and client
 *                      authentication (#52, D5), and on /token grant-guard
 *                      (D6); on /register the DCR validator and then the
 *                      per-redirect-host limit
 *   router             what answers: the library (as-library, D1), the
 *                      protected-resource metadata (metadata), or the YNAB
 *                      sign-in (ynab-federation: the interaction router)
 *
 * The order is fixed by routePipeline() below; a change only adds a stage to
 * a position. Validators live in their own modules: this file holds glue
 * only. tests/unit/http-as-pipeline.test.ts asserts each route's exact stage
 * list (gate G21), so a change to a pipeline changes that test on purpose.
 *
 * Two pieces of the guard can't be stages, because they act inside the
 * library: the provider's normalizer (provider.ts: D7, the pinned origin) and
 * authorize-guard's redirect net (`provider.use`, see authorize-guard.ts).
 *
 * mountAuthorizationServer() runs after Host/Origin validation and before the
 * app's global JSON parser, so these stages decide what an AS request costs
 * before anything else reads it. The library relies on that: `provider.proxy`
 * is on (provider.ts pins the forwarded headers it reads), and on /token it
 * reads the body `bounded-parser` parsed (its "already parsed request body"
 * warning, logged once, is expected).
 */

import express, { type Request, type Response, type Router } from 'express';
import type Provider from 'oidc-provider';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { HttpConfig } from '../config/environment.js';
import type { Encryptor } from '../crypto.js';
import type { Storage } from '../storage/types.js';
import { clientAuthentication } from './client-auth.js';
import type { TokenHasher } from './token-hash.js';
import type { YnabOAuthConfig } from './ynab-oauth.js';
import { redirectPolicyFrom } from './client-metadata.js';
import { dcrValidator } from './dcr-validator.js';
import { authorizeValidation } from './authorize-validation.js';
import { authorizeGuard, authorizeRedirectGuard } from './authorize-guard.js';
import { grantGuard } from './grant-guard.js';
import { methodCheck } from './method-check.js';
import { answerPreflight, metadataDocument } from './metadata-document.js';
import { protectedResourceMetadataUrl } from './resource.js';
import { asLibraryHandler, createOidcProvider, DISCOVERY_PATHS, INTERACTION_BASE_PATH, OIDC_ROUTES } from './oidc/provider.js';
import { interactionRouter } from './oidc/interaction.js';
import { createAccessTokenVerifier } from './oidc/verifier.js';
import { libraryClients } from './oidc/clients.js';
import {
  CEILING_FACTOR,
  keyedLimiter,
  registerHostLimiter,
  registerIpLimiter,
  type LimiterStoreFactory,
} from '../middleware/rate-limiters.js';
import { authorizeClientId, bodyClientId, verifiedRedirectHosts } from '../middleware/rate-limit-key.js';
import {
  AS_MAX_BODY,
  mountStages,
  stage,
  type RoutePipeline,
  type Stage,
  type StageObserver,
} from '../http/pipeline.js';

/** Requests per client IP per 15 minutes on the YNAB OAuth legs, matching /authorize. */
export const OAUTH_LEG_RATE_LIMIT = 100;

/**
 * Requests per (client_id, IP) per 15 minutes on /token and on /revoke (each
 * its own budget): the SDK's per-route default, applied by the route-limiter
 * stage ahead of client authentication. Each route's ip-limiter allows
 * CEILING_FACTOR times this per IP.
 */
export const CLIENT_AUTH_ROUTE_RATE_LIMIT = 50;

/** Requests per (client_id, IP) per 15 minutes on /authorize, the SDK's default, applied by the limiter stage. */
export const AUTHORIZE_RATE_LIMIT = 100;

/** One AS route. The positions are fixed; routePipeline() puts them in order. */
interface AsRoute {
  /** The path prefix it is mounted on (app.use semantics), and its name in the pipeline test. */
  readonly path: string;
  /** Rate limits, in order, all ahead of the parser. */
  readonly limiters?: readonly Stage[];
  readonly parser: Stage;
  readonly slots?: readonly Stage[];
  readonly router: Stage;
}

/**
 * Wrap a body parser so its failures answer as OAuth errors (RFC 6749 section
 * 5.2 shape) instead of reaching the app's JSON-RPC error handler: 413 with
 * `invalid_request` for a body over the limit, 400 (or the parser's own 4xx)
 * for a body that doesn't parse. Nothing from the body is echoed. The parser
 * runs before cors-origin, so the answer carries `Access-Control-Allow-Origin:
 * *` itself and a browser client can read it (no credentials ride on it).
 */
function oauthShapedParseErrors(parse: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    void parse(req, res, (err?: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }
      const e = err as { type?: unknown; status?: unknown };
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (e.type === 'entity.too.large') {
        res.status(413).json({ error: 'invalid_request', error_description: 'Request body too large' });
        return;
      }
      const status = typeof e.status === 'number' && e.status >= 400 && e.status < 500 ? e.status : 400;
      res.status(status).json({ error: 'invalid_request', error_description: 'Malformed request body' });
    });
  };
}

/** The stages of a route, in the one order every route uses. */
function routePipeline(route: AsRoute): Stage[] {
  return [
    ...(route.limiters ?? []),
    route.parser,
    ...(route.slots ?? []),
    route.router,
  ];
}

/**
 * D8's cors-origin, on /token, /revoke and /register, ahead of method-check:
 * a browser's preflight gets 204 with the CORS headers here and never a 405;
 * any other request gets `Access-Control-Allow-Origin: *` and goes on, so a
 * 405, 429 or `invalid_client` from a later stage is readable by a browser
 * client. Because the header is already set, the library's own CORS steps
 * aside on these routes (D2).
 */
function corsOrigin(req: Request, res: Response, next: express.NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'OPTIONS') {
    next();
    return;
  }
  answerPreflight(req, res, 'POST');
}

export interface AuthorizationServerOptions {
  config: HttpConfig;
  storage: Storage;
  encryptor: Encryptor;
  /** The hasher storage was opened with: the same instance, so the same pepper (#52). */
  tokenHasher: TokenHasher;
  /** This server's YNAB OAuth application. */
  ynab: YnabOAuthConfig;
  /** Tests only: reports each stage as a request enters it (see StageObserver). */
  observeStage?: StageObserver | undefined;
  /** A shared store for the rate limiters (#67b); the in-memory default when absent. */
  limiterStore?: LimiterStoreFactory | undefined;
}

export interface AuthorizationServer {
  /** The `/mcp` token verifier (ADR-0002 D10). */
  provider: OAuthTokenVerifier;
  /** The library instance (ADR-0002 D1). */
  oidc: Provider;
  /** The protected resource (RFC 8707 audience) every token is bound to. */
  resourceServerUrl: URL;
  /** RFC 9728 metadata URL, advertised in /mcp's 401 challenges. */
  resourceMetadataUrl: string;
  /** Each mounted route and its stage names, in mount order (host validation not included). */
  routes: RoutePipeline[];
}

/**
 * Build the authorization server and mount its routes on `app`. Call it after
 * Host/Origin validation and before the app's global body parser.
 */
export function mountAuthorizationServer(
  app: Router,
  options: AuthorizationServerOptions
): AuthorizationServer {
  const { config, storage, encryptor, tokenHasher, ynab, observeStage, limiterStore } = options;
  const publicUrl = config.publicUrl as string;
  // The protected resource (RFC 8707 audience) every token is bound to.
  const resourceServerUrl = new URL(config.resourceUrl ?? `${publicUrl}/mcp`);
  // #55: how registrations, authorization errors and the consent page treat redirect URIs.
  const redirectPolicy = redirectPolicyFrom(config);

  const oidc = createOidcProvider({
    store: storage,
    keys: tokenHasher,
    publicUrl,
    resourceUrl: config.resourceUrl,
    encryptionKey: config.encryptionKey as string,
    accessTokenTtlSec: config.accessTokenTtlSec,
    authCodeTtlSec: config.authCodeTtlSec,
  });
  const { provider, issuer, resource } = oidc;
  // authorize-guard's fail-closed net, inside the library (see authorize-guard.ts).
  provider.use(
    authorizeRedirectGuard({
      publicUrl,
      authorizationPath: OIDC_ROUTES.authorization,
      interactionPath: INTERACTION_BASE_PATH,
    })
  );
  const clients = libraryClients(provider);

  // Protected-resource metadata (RFC 9728) describes the MCP endpoint, so it is
  // served at the path-aware well-known URL for the resource (e.g.
  // /.well-known/oauth-protected-resource/mcp), by our own metadata stage.
  const resourceMetadataUrl = protectedResourceMetadataUrl(resourceServerUrl);
  const protectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuer],
    scopes_supported: ['read-only', 'read-write'],
    bearer_methods_supported: ['header'],
    resource_name: 'YNAB MCP Server',
  };
  const pathOf = (endpoint: string): string => new URL(endpoint).pathname;

  // One body parser per route, at AS_MAX_BODY (8kb, #55a): no OAuth request
  // comes near it. Every route takes both JSON and form bodies (/token and
  // /revoke read forms; /register reads JSON); the library and the global
  // parser after this router use the body parsed here.
  const boundedParser = (): Stage =>
    stage(
      'bounded-parser',
      ...[express.json({ limit: AS_MAX_BODY }), express.urlencoded({ extended: false, limit: AS_MAX_BODY })].map(
        oauthShapedParseErrors
      )
    );
  const metadata = (doc: Readonly<Record<string, unknown>>): Stage => stage('metadata', ...metadataDocument(doc));
  const library = asLibraryHandler(provider);
  const asLibrary = (): Stage => stage('as-library', library);
  const methods = (...allowed: string[]): Stage => stage('method-check', methodCheck(allowed));
  const cors = (): Stage => stage('cors-origin', corsOrigin);

  // The YNAB legs get /authorize's limit (100 per 15 minutes), the step right
  // before them in the same browser flow, so a login that gets past /authorize
  // isn't then refused here. The callback and complete read storage and call
  // YNAB's token endpoint, so they must not be unlimited. Ahead of the parser
  // so a limited request costs no parsing. The client IP comes from req.ip, so
  // TRUST_PROXY must match the proxy hops, or every client behind the proxy
  // shares one budget. One limiter for all the legs.
  const keyOptions = { trustCfConnectingIp: config.trustCfConnectingIp };
  const WINDOW_15_MIN = 15 * 60 * 1000;
  const tooMany = (what: string): unknown =>
    new OAuthError(OAuthErrorCode.TooManyRequests, `You have exceeded the rate limit for ${what} requests`).toResponseObject();
  const oauthLegLimiter = stage(
    'oauth-leg-limiter',
    ...keyedLimiter({
      name: 'oauth-leg',
      windowMs: WINDOW_15_MIN,
      limit: OAUTH_LEG_RATE_LIMIT,
      message: 'Too many authorization requests. Please wait and try again.',
      key: keyOptions,
      store: limiterStore,
    })
  );

  // /token and /revoke: the SDK's per-route limit (50 per 15 minutes), ahead
  // of client authentication so wrong-secret attempts are counted and refused
  // with 429 past it (G21). Keyed by (client_id, IP) (#59); the IP-only
  // ceiling is the route's ip-limiter, ahead of the parser. Only POSTs carry
  // credentials (cors-origin answers preflights, method-check the rest).
  const routeLimiter = (what: string): Stage =>
    stage(
      'route-limiter',
      ...keyedLimiter({
        name: `route:${what}`,
        windowMs: WINDOW_15_MIN,
        limit: CLIENT_AUTH_ROUTE_RATE_LIMIT,
        message: tooMany(what),
        key: keyOptions,
        // The body client_id: the one client authentication checks.
        clientId: bodyClientId,
        ceiling: false,
        store: limiterStore,
        skip: (req) => req.method !== 'POST',
      })
    );
  // /authorize: the SDK's 100 per 15 minutes. An IP-only guard ahead of the
  // parser (ten times the budget, so a limited request costs no parsing), then
  // the (client_id, IP) budget, keyed by the query's client_id. The resume
  // route (/authorize/:uid) has none and counts against the IP's.
  const authorizeIpLimiter = stage(
    'ip-limiter',
    ...keyedLimiter({
      name: 'authorize:ip',
      windowMs: WINDOW_15_MIN,
      limit: AUTHORIZE_RATE_LIMIT * CEILING_FACTOR,
      message: tooMany('authorization'),
      key: keyOptions,
      store: limiterStore,
    })
  );
  const authorizeLimiter = stage(
    'route-limiter',
    ...keyedLimiter({
      name: 'authorize',
      windowMs: WINDOW_15_MIN,
      limit: AUTHORIZE_RATE_LIMIT,
      message: tooMany('authorization'),
      key: keyOptions,
      clientId: authorizeClientId,
      ceiling: false,
      store: limiterStore,
    })
  );
  // /token and /revoke: route-limiter's IP-only ceiling, ahead of the parser
  // like /authorize's (#55a), so a flood of bodies, well-formed or not, costs
  // no parsing. Each route has its own. Its 429 carries the CORS header the
  // later cors-origin stage would have set, so a browser client can read it.
  const clientAuthIpLimiter = (what: string): Stage =>
    stage(
      'ip-limiter',
      ...keyedLimiter({
        name: `route:${what}:ip`,
        windowMs: WINDOW_15_MIN,
        limit: CLIENT_AUTH_ROUTE_RATE_LIMIT * CEILING_FACTOR,
        message: tooMany(what),
        key: keyOptions,
        cors: true,
        store: limiterStore,
      })
    );
  // /register: a per-IP limit above the SDK's 20/h before the body is read,
  // then a per-redirect-host limit once the DCR validator has accepted it
  // (hosted clients share an IP range but not a redirect host). A verified
  // host is shared by every user of that client, so it is counted per host
  // and IP, like loopback.
  const registerLimits = {
    windowMs: 60 * 60 * 1000,
    perIp: config.registerRateLimitPerIp,
    perHost: config.registerRateLimitPerHost,
    verifiedHosts: verifiedRedirectHosts(config.verifiedRedirectUris),
    message: tooMany('client registration'),
    tooManyRedirects: {
      error: 'invalid_client_metadata',
      error_description: 'Too many redirect_uris',
    },
    key: keyOptions,
    store: limiterStore,
  };
  const registerIp = stage('ip-limiter', ...registerIpLimiter(registerLimits));
  const registerHost = stage('register-host-limiter', registerHostLimiter(registerLimits));
  const clientAuth = (): Stage => stage('client-auth', clientAuthentication(clients));

  // The documents are static and get no limiter; /oauth has its own.
  const routes: AsRoute[] = [
    { path: pathOf(resourceMetadataUrl), parser: boundedParser(), router: metadata(protectedResourceMetadata) },
    // Root alias for clients that probe the non-path-aware location.
    { path: '/.well-known/oauth-protected-resource', parser: boundedParser(), router: metadata(protectedResourceMetadata) },
    // The library's discovery documents and JWKS: its open CORS answers the preflight.
    ...[...DISCOVERY_PATHS, OIDC_ROUTES.jwks].map(
      (path): AsRoute => ({ path, parser: boundedParser(), slots: [methods('GET', 'OPTIONS')], router: asLibrary() })
    ),
    {
      path: OIDC_ROUTES.authorization,
      limiters: [authorizeIpLimiter],
      parser: boundedParser(),
      slots: [
        // GET only: POST /authorize isn't served (provider.ts).
        methods('GET'),
        authorizeLimiter,
        // #55a: bounds, and the refusal of grandfathered plain-http clients.
        stage('authorize-validation', authorizeValidation({ clients, policy: redirectPolicy, issuer })),
        // #55b: no error redirect to an unverified client's redirect URI.
        stage('authorize-guard', authorizeGuard({ issuer, resource })),
      ],
      router: asLibrary(),
    },
    {
      path: OIDC_ROUTES.token,
      limiters: [clientAuthIpLimiter('token')],
      parser: boundedParser(),
      slots: [
        cors(),
        methods('POST'),
        routeLimiter('token'),
        clientAuth(),
        stage('grant-guard', grantGuard({ provider, store: storage })),
      ],
      router: asLibrary(),
    },
    {
      path: OIDC_ROUTES.registration,
      limiters: [registerIp],
      parser: boundedParser(),
      // cors-origin first, so a browser client can read every refusal; the
      // validator before the host limit, so a refused registration spends no
      // redirect host's budget.
      slots: [cors(), methods('POST'), stage('dcr-validator', dcrValidator(redirectPolicy)), registerHost],
      router: asLibrary(),
    },
    {
      path: OIDC_ROUTES.revocation,
      limiters: [clientAuthIpLimiter('token revocation')],
      parser: boundedParser(),
      slots: [cors(), methods('POST'), routeLimiter('token revocation'), clientAuth()],
      router: asLibrary(),
    },
    {
      path: '/oauth',
      limiters: [oauthLegLimiter],
      parser: boundedParser(),
      router: stage(
        'ynab-federation',
        interactionRouter({
          provider,
          store: storage,
          encryptor,
          tokenHasher,
          ynab,
          publicUrl,
          resource,
          allowWrite: config.allowWrite,
          globalReadOnly: config.readOnly,
          redirectPolicy,
        })
      ),
    },
  ];

  const mounted = routes.map((route) => ({
    route: route.path,
    stages: mountStages(app, route.path, routePipeline(route), observeStage),
  }));

  return {
    provider: createAccessTokenVerifier({ provider, resource }),
    oidc: provider,
    resourceServerUrl,
    resourceMetadataUrl,
    routes: mounted,
  };
}
