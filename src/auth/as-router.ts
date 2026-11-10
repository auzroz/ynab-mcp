/**
 * The OAuth 2.1 authorization server (oauth mode): the provider, the
 * protected-resource and authorization-server metadata, the SDK's /authorize,
 * /token, /register and /revoke handlers, and the YNAB federation legs under
 * /oauth with their rate limit.
 *
 * Every route is a pipeline of named stages, always in this order:
 *
 *   [host-validation]  mounted by http.ts on the whole app, before this router
 *   ...limiters        rate limits, before any body is read (today only the
 *                      /oauth legs' oauth-leg-limiter; #55a adds an AS-wide
 *                      as-limiter ahead of it on every route)
 *   bounded-parser     the request-body parser, with its size limit
 *   ...slots           route-specific checks: iss-redirect on /authorize; on
 *                      /token and /revoke the route limiter and then client
 *                      authentication (#52); later the /authorize and DCR
 *                      validators
 *   router             the handler that answers: the SDK's (sdk-router), the
 *                      metadata document, or the YNAB federation legs
 *
 * The order is fixed by routePipeline() below; a change only adds a stage to
 * a position. Validators live in their own pure modules: this file holds glue
 * only. tests/unit/http-as-pipeline.test.ts asserts each route's exact stage
 * list (gate G21), so a change to a pipeline changes that test on purpose.
 *
 * mountAuthorizationServer() runs after Host/Origin validation and before the
 * app's global JSON parser, so these stages decide what an AS request costs
 * before anything else reads it.
 */

import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import type { HttpConfig } from '../config/environment.js';
import type { Encryptor } from '../crypto.js';
import type { Storage } from '../storage/types.js';
import { McpOAuthProvider } from './mcp-provider.js';
import { clientAuthentication } from './client-auth.js';
import { TokenHasher } from './token-hash.js';
import type { YnabOAuthConfig } from './ynab-oauth.js';
import { issOnAuthorizationRedirects } from '../middleware/iss-redirect.js';
import {
  MAX_JSON_BODY,
  mountStages,
  stage,
  type RoutePipeline,
  type Stage,
  type StageObserver,
} from '../http/pipeline.js';

/** Requests per client IP per 15 minutes on the YNAB OAuth legs, matching the SDK's /authorize. */
export const OAUTH_LEG_RATE_LIMIT = 100;

/**
 * Requests per client IP per 15 minutes on /token and on /revoke (each its own
 * budget): the SDK's per-route default, now applied by the route-limiter stage
 * ahead of client authentication instead of inside the SDK handler.
 */
export const CLIENT_AUTH_ROUTE_RATE_LIMIT = 50;

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

/** The stages of a route, in the one order every route uses. */
function routePipeline(route: AsRoute): Stage[] {
  return [
    ...(route.limiters ?? []),
    route.parser,
    ...(route.slots ?? []),
    route.router,
  ];
}

export interface AuthorizationServerOptions {
  config: HttpConfig;
  storage: Storage;
  encryptor: Encryptor;
  /** This server's YNAB OAuth application. */
  ynab: YnabOAuthConfig;
  /** Tests only: reports each stage as a request enters it (see StageObserver). */
  observeStage?: StageObserver | undefined;
}

export interface AuthorizationServer {
  provider: McpOAuthProvider;
  /** The protected resource (RFC 8707 audience) every token is bound to. */
  resourceServerUrl: URL;
  /** RFC 9728 metadata URL, advertised in /mcp's 401 challenges. */
  resourceMetadataUrl: string;
  /** Each mounted route and its stage names, in mount order (host validation not included). */
  routes: RoutePipeline[];
}

/** The /oauth/ynab/start, /oauth/ynab/callback and /oauth/cancel handlers. */
function ynabFederationLegs(provider: McpOAuthProvider): Router {
  const legs = express.Router();
  // Each leg requires the consent cookie that /authorize set for this state
  // (provider.consentCookie), so the legs only run in the browser that was
  // shown the consent page.
  const consentNonce = (req: Request, state: string): string | undefined =>
    provider.consentCookie.read(req.header('cookie'), state);
  legs.get('/ynab/start', async (req: Request, res: Response) => {
    try {
      const state = String(req.query['state'] ?? '');
      const scope = req.query['scope'] === 'read-write' ? 'read-write' : 'read-only';
      const url = await provider.startYnabAuthorization(state, scope, consentNonce(req, state));
      res.redirect(url);
    } catch {
      res.status(400).send('Authorization request expired or invalid. Please start over.');
    }
  });
  legs.get('/ynab/callback', async (req: Request, res: Response) => {
    try {
      const code = String(req.query['code'] ?? '');
      const state = String(req.query['state'] ?? '');
      const error = req.query['error'];
      if (state && error !== undefined) {
        // YNAB refused (e.g. the user clicked Deny). Tell the MCP client, with a
        // fixed error code; YNAB's own error text is never forwarded.
        const denial = error === 'access_denied' ? 'access_denied' : 'server_error';
        const redirect = await provider.denyAuthorization(state, denial, consentNonce(req, state));
        res.append('Set-Cookie', provider.consentCookie.clear(state));
        res.redirect(redirect);
        return;
      }
      if (!code || !state) {
        res.status(400).send('Missing code or state.');
        return;
      }
      const redirect = await provider.handleYnabCallback(code, state, consentNonce(req, state));
      res.append('Set-Cookie', provider.consentCookie.clear(state));
      res.redirect(redirect);
    } catch {
      res.status(400).send('Could not complete YNAB authorization. Please start over.');
    }
  });
  // "Cancel" on the consent screen: an access_denied authorization response.
  legs.get('/cancel', async (req: Request, res: Response) => {
    try {
      const state = String(req.query['state'] ?? '');
      if (!state) {
        res.status(400).send('Missing state.');
        return;
      }
      const redirect = await provider.denyAuthorization(state, 'access_denied', consentNonce(req, state));
      res.append('Set-Cookie', provider.consentCookie.clear(state));
      res.redirect(redirect);
    } catch {
      res.status(400).send('Authorization request expired or invalid. Please start over.');
    }
  });
  return legs;
}

/**
 * Build the authorization server and mount its routes on `app`. Call it after
 * Host/Origin validation and before the app's global body parser.
 */
export function mountAuthorizationServer(
  app: Router,
  options: AuthorizationServerOptions
): AuthorizationServer {
  const { config, storage, encryptor, ynab, observeStage } = options;
  const publicUrl = config.publicUrl as string;
  // The protected resource (RFC 8707 audience) every token is bound to.
  const resourceServerUrl = new URL(config.resourceUrl ?? `${publicUrl}/mcp`);
  // The issuer identifier: published in AS metadata and sent as `iss` on every
  // authorization response (RFC 9207), so both must use this exact string.
  const issuerUrl = new URL(publicUrl);
  const provider = new McpOAuthProvider({
    storage,
    encryptor,
    // The same pepper http.ts handed storage (TOKEN_PEPPER, else from ENCRYPTION_KEY).
    tokenHasher: TokenHasher.fromSecrets({ tokenPepper: config.tokenPepper, encryptionKey: config.encryptionKey }),
    ynab,
    publicUrl,
    issuer: issuerUrl.href,
    resourceUrl: resourceServerUrl.href,
    allowWrite: config.allowWrite,
    globalReadOnly: config.readOnly,
    accessTokenTtlSec: config.accessTokenTtlSec,
    authCodeTtlSec: config.authCodeTtlSec,
  });

  // Protected-resource metadata (RFC 9728) describes the MCP endpoint, so it is
  // served at the path-aware well-known URL for the resource (e.g.
  // /.well-known/oauth-protected-resource/mcp). The SDK's own PRM lacks
  // bearer_methods_supported, so this one is served instead, with the SDK's
  // metadataHandler (CORS: any origin, GET/OPTIONS only).
  const scopesSupported = ['read-only', 'read-write'];
  const resourceName = 'YNAB MCP Server';
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const protectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: scopesSupported,
    bearer_methods_supported: ['header'],
    resource_name: resourceName,
  };

  // AS metadata (RFC 8414) is the SDK's, plus
  // authorization_response_iss_parameter_supported (RFC 9207 section 3), which
  // the SDK does not emit.
  const oauthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl, scopesSupported }),
    authorization_response_iss_parameter_supported: true,
  };
  const pathOf = (endpoint: string): string => new URL(endpoint).pathname;

  // One body parser per route, with the app-wide limit (unchanged from when
  // the global parser read these bodies). express.json skips a body that an
  // earlier parser read, so the global parser after this router doesn't
  // parse it twice.
  const boundedParser = (): Stage => stage('bounded-parser', express.json({ limit: MAX_JSON_BODY }));
  // /token and /revoke take form bodies, which client authentication reads
  // before the SDK handler does: the SDK's own form parser (extended: false,
  // its default 100kb) moves into this stage, and the SDK's then skips the
  // already-read body.
  const boundedFormParser = (): Stage =>
    stage(
      'bounded-parser',
      express.json({ limit: MAX_JSON_BODY }),
      express.urlencoded({ extended: false })
    );
  const metadata = (doc: Parameters<typeof metadataHandler>[0]): Stage => stage('metadata', metadataHandler(doc));
  const sdkRouter = (handler: express.RequestHandler): Stage => stage('sdk-router', handler);

  // The YNAB OAuth legs get the limit the SDK puts on /authorize (100 per 15
  // minutes), the step right before them in the same browser flow, so a login
  // that gets past /authorize isn't then refused here. The callback reads
  // storage and can call YNAB's token endpoint, so it must not be unlimited.
  // Ahead of the parser so a limited request costs no parsing. The client IP
  // comes from req.ip, so TRUST_PROXY must match the proxy hops, or every
  // client behind the proxy shares one budget. One limiter for all the legs.
  const oauthLegLimiter = stage(
    'oauth-leg-limiter',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: OAUTH_LEG_RATE_LIMIT,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many authorization requests. Please wait and try again.',
    })
  );

  // /token and /revoke: the SDK's per-route limit (50 per 15 minutes per IP),
  // moved ahead of client authentication so wrong-secret attempts are counted
  // and refused with 429 past it (G21). IP-keyed until #59. The SDK handler's
  // own limiter is turned off, so each request is counted once.
  const routeLimiter = (what: string): Stage =>
    stage(
      'route-limiter',
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: CLIENT_AUTH_ROUTE_RATE_LIMIT,
        standardHeaders: true,
        legacyHeaders: false,
        // Only POSTs carry credentials. The SDK's own limiter ran after its
        // CORS handler, so preflights were never counted; they still aren't.
        skip: (req) => req.method !== 'POST',
        message: new TooManyRequestsError(`You have exceeded the rate limit for ${what} requests`).toResponseObject(),
      })
    );
  const clientAuth = (): Stage => stage('client-auth', clientAuthentication(provider.clientsStore));

  // The SDK's handlers are mounted one per route, exactly as its mcpAuthRouter
  // composes them (it mounts /register and /revoke only when the provider
  // supports them), without its own metadata routes, which the ones here
  // replace. Each SDK handler still applies its own CORS, method check, form
  // parser and (except on /token and /revoke, whose limit is the route-limiter
  // stage) per-route rate limit inside the sdk-router stage.
  // The limiters position on these routes is empty for now (#55a adds an
  // as-limiter ahead of the parser on every route, /oauth included, where it
  // goes before oauth-leg-limiter).
  const routes: AsRoute[] = [
    { path: pathOf(resourceMetadataUrl), parser: boundedParser(), router: metadata(protectedResourceMetadata) },
    // Root alias for clients that probe the non-path-aware location.
    { path: '/.well-known/oauth-protected-resource', parser: boundedParser(), router: metadata(protectedResourceMetadata) },
    { path: '/.well-known/oauth-authorization-server', parser: boundedParser(), router: metadata(oauthMetadata) },
    {
      path: pathOf(oauthMetadata.authorization_endpoint),
      parser: boundedParser(),
      // The SDK's /authorize handler redirects errors to the client without
      // `iss`; this adds it to every redirect from the authorization endpoint.
      slots: [stage('iss-redirect', issOnAuthorizationRedirects(oauthMetadata.issuer))],
      router: sdkRouter(authorizationHandler({ provider })),
    },
    {
      path: pathOf(oauthMetadata.token_endpoint),
      parser: boundedFormParser(),
      slots: [routeLimiter('token'), clientAuth()],
      router: sdkRouter(tokenHandler({ provider, rateLimit: false })),
    },
  ];
  if (oauthMetadata.registration_endpoint) {
    routes.push({
      path: pathOf(oauthMetadata.registration_endpoint),
      parser: boundedParser(),
      router: sdkRouter(clientRegistrationHandler({ clientsStore: provider.clientsStore })),
    });
  }
  if (oauthMetadata.revocation_endpoint) {
    routes.push({
      path: pathOf(oauthMetadata.revocation_endpoint),
      parser: boundedFormParser(),
      slots: [routeLimiter('token revocation'), clientAuth()],
      router: sdkRouter(revocationHandler({ provider, rateLimit: false })),
    });
  }
  routes.push({
    path: '/oauth',
    limiters: [oauthLegLimiter],
    parser: boundedParser(),
    router: stage('ynab-federation', ynabFederationLegs(provider)),
  });

  const mounted = routes.map((route) => ({
    route: route.path,
    stages: mountStages(app, route.path, routePipeline(route), observeStage),
  }));

  return { provider, resourceServerUrl, resourceMetadataUrl, routes: mounted };
}
