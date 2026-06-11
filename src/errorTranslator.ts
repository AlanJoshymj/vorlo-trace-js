/**
 * Vorlo Error Translator — transforms raw HTTP/exception errors into
 * plain-English root cause diagnoses with actionable fix hints.
 *
 * This is the core of Vorlo's value proposition. Every error that reaches
 * the dashboard goes through this translator first. We never show raw
 * stack traces or HTTP status codes to developers.
 *
 * Faithful port of the Python `error_translator.py`.
 */

export interface ErrorDiagnosis {
  code: string;
  title: string;
  plain_english: string;
  root_cause: string;
  fix_hint: string;
  /** "critical" | "warning" | "info" */
  severity: string;
  docs_url: string;
}

export interface PreviousStep {
  step_number?: number;
  tool_name?: string;
  tool_type?: string;
  status?: string;
  output_preview?: string;
  error_code?: string;
}

interface TranslateContext {
  tool_name: string;
  tool_prefix: string;
  error_type: string;
  http_status: number | null;
  raw_message: string;
  previous_steps: PreviousStep[];
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate keeping both head and tail. Stack traces put the actual exception
 * at the END, so head-only truncation would show boilerplate frames and cut
 * the error itself. Mirrors the Python SDK's truncate_keep_tail.
 */
export function truncateKeepTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength / 3);
  const tail = maxLength - head - 5;
  return `${text.slice(0, head)} ... ${text.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Helper functions for building context-aware root causes
// ---------------------------------------------------------------------------

function authRootCause(ctx: TranslateContext): string {
  const parts = [
    `The credentials used for '${ctx.tool_name}' were rejected by the upstream service.`,
  ];
  if (ctx.previous_steps.length) {
    const prevTools = ctx.previous_steps.map((s) => s.tool_name ?? 'unknown');
    parts.push(
      `Previous steps in this session called: ${prevTools.join(', ')}. ` +
        'If any of those steps modified or refreshed auth state, the token ' +
        'may not have propagated to this step.',
    );
  }
  return parts.join(' ');
}

function rateLimitRootCause(ctx: TranslateContext, service: string, limit: string): string {
  const parts = [`The agent exceeded ${service}'s rate limit of ${limit}.`];
  if (ctx.previous_steps.length) {
    const sameToolCount = ctx.previous_steps.filter((s) =>
      (s.tool_name ?? '').startsWith(ctx.tool_prefix),
    ).length;
    if (sameToolCount > 0) {
      parts.push(
        `In the last ${ctx.previous_steps.length} steps, ${sameToolCount} ` +
          `also called ${service} tools — this burst likely triggered the limit.`,
      );
    }
  }
  return parts.join(' ');
}

function notFoundRootCause(ctx: TranslateContext): string {
  const parts = [
    `The resource requested by '${ctx.tool_name}' does not exist on the upstream service.`,
  ];
  if (ctx.previous_steps.length) {
    parts.push(
      'This may be caused by an incorrect ID or identifier passed from a previous step. ' +
        'Check the output of earlier steps — the ID format may differ from what this tool expects.',
    );
  }
  return parts.join(' ');
}

function keyErrorRootCause(ctx: TranslateContext): string {
  const parts = [`A required field was missing when '${ctx.tool_name}' tried to access it.`];
  const keyMatch = ctx.raw_message.match(/['"](\w+)['"]/);
  if (keyMatch) {
    const missingKey = keyMatch[1];
    parts.push(`The missing field is '${missingKey}'.`);
    if (ctx.previous_steps.length) {
      parts.push(
        `Check the output of previous steps — the field '${missingKey}' may have been ` +
          'renamed, nested differently, or omitted from the response.',
      );
    }
  }
  return parts.join(' ');
}

function typeErrorRootCause(ctx: TranslateContext): string {
  const parts = [`'${ctx.tool_name}' received data in an unexpected type or format.`];
  if (ctx.raw_message.includes('NoneType') || /\bnull\b|\bundefined\b/.test(ctx.raw_message)) {
    parts.push(
      'A value was null/None when a valid object was expected. ' +
        'This often happens when a previous step returned no data (e.g., a search ' +
        'returned no results) and the agent passed it to the next step.',
    );
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Pattern registry — maps (tool_prefix, http_status, message_regex) → builder
// ---------------------------------------------------------------------------

interface HttpPattern {
  tool_prefix: string | null;
  statuses: Set<number>;
  message_re: RegExp;
  build: (ctx: TranslateContext) => ErrorDiagnosis;
}

const HTTP_PATTERNS: HttpPattern[] = [
  // ── Auth / Token errors ──────────────────────────────────────────────
  {
    tool_prefix: 'stripe',
    statuses: new Set([401, 403]),
    message_re: /(invalid.api.key|no.such.customer|expired|authentication)/i,
    build: (ctx) => ({
      code: 'stripe_auth_error',
      title: 'Stripe authentication failed',
      plain_english:
        `Stripe rejected the request to '${ctx.tool_name}' with ` +
        `HTTP ${ctx.http_status}. This usually means the API key is ` +
        'invalid, expired, or does not have the required scope.',
      root_cause: authRootCause(ctx),
      fix_hint:
        'Check your Stripe API key in Settings → Integrations. ' +
        'Ensure it has the required scope for this operation. ' +
        'If using test-mode keys against live resources (or vice versa), switch to the correct key.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/stripe_auth_error',
    }),
  },
  {
    tool_prefix: 'salesforce',
    statuses: new Set([401, 403]),
    message_re: /(unauthorized|session.expired|invalid.session|token)/i,
    build: (ctx) => ({
      code: 'salesforce_token_expired',
      title: 'Salesforce OAuth token expired or invalid',
      plain_english:
        `Salesforce rejected '${ctx.tool_name}' with HTTP ${ctx.http_status}. ` +
        'Salesforce OAuth tokens expire after 24 hours by default.',
      root_cause:
        'The OAuth token was likely issued more than 24 hours ago and has expired. ' +
        'Salesforce does not auto-refresh tokens — the client must handle renewal.',
      fix_hint:
        'Reconnect your Salesforce account in Settings → Integrations to get a fresh token. ' +
        'In Phase 2, Vorlo will auto-refresh tokens 5 minutes before expiry.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/salesforce_token_expired',
    }),
  },
  {
    tool_prefix: 'gmail',
    statuses: new Set([401, 403]),
    message_re: /(invalid.credentials|token.expired|insufficient.permission|forbidden)/i,
    build: (ctx) => ({
      code: 'gmail_auth_error',
      title: 'Gmail authentication or permission error',
      plain_english:
        `Gmail rejected '${ctx.tool_name}' with HTTP ${ctx.http_status}. ` +
        'The OAuth token may be expired or the required Gmail API scope was not granted.',
      root_cause:
        'Google OAuth tokens expire after 1 hour. If the token was not refreshed, ' +
        'any Gmail API call will fail with a 401. Alternatively, the OAuth consent ' +
        'screen may not have included the required scope for this operation.',
      fix_hint:
        'Re-authorize your Google account and ensure the required Gmail scopes are granted. ' +
        'Check that the OAuth consent screen includes the scope needed for this tool.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/gmail_auth_error',
    }),
  },
  // ── Generic auth for any tool ────────────────────────────────────────
  {
    tool_prefix: null,
    statuses: new Set([401]),
    message_re: /.*/i,
    build: (ctx) => ({
      code: 'auth_unauthorized',
      title: 'Authentication failed',
      plain_english:
        `The tool '${ctx.tool_name}' returned HTTP 401 Unauthorized. ` +
        'The API key or OAuth token used for this request is invalid or expired.',
      root_cause:
        'The credentials provided to this tool were rejected by the upstream service. ' +
        'This typically happens when tokens expire, keys are rotated, or the wrong ' +
        'environment (test vs production) is used.',
      fix_hint:
        'Verify the API key or OAuth token for this tool is current and valid. ' +
        'Check if the token has expired and needs to be refreshed or re-issued.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/auth_unauthorized',
    }),
  },
  {
    tool_prefix: null,
    statuses: new Set([403]),
    message_re: /.*/i,
    build: (ctx) => ({
      code: 'auth_forbidden',
      title: 'Permission denied',
      plain_english:
        `The tool '${ctx.tool_name}' returned HTTP 403 Forbidden. ` +
        'The credentials are valid but lack the required permissions for this operation.',
      root_cause:
        'The API key or OAuth token has been accepted by the service but does not have ' +
        'the necessary scope or role to perform this specific action. This is a permissions ' +
        'issue, not an authentication issue.',
      fix_hint:
        'Grant the required scope or permission for this tool. Check the tool\'s ' +
        'API documentation for the exact scope needed for this operation.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/auth_forbidden',
    }),
  },
  // ── Rate limiting ────────────────────────────────────────────────────
  {
    tool_prefix: 'gmail',
    statuses: new Set([429]),
    message_re: /.*/i,
    build: (ctx) => ({
      code: 'gmail_rate_limit_exceeded',
      title: 'Gmail API rate limit exceeded',
      plain_english:
        `Gmail rate-limited '${ctx.tool_name}'. ` +
        'Gmail allows approximately 25 requests per minute per user.',
      root_cause: rateLimitRootCause(ctx, 'Gmail', '25 requests per minute per user'),
      fix_hint:
        'Add a 2-3 second delay between consecutive Gmail API calls. ' +
        'If the agent is in a retry loop, add exponential backoff. ' +
        'Check if a previous step triggered excessive retries.',
      severity: 'warning',
      docs_url: 'https://vorlo.dev/errors/gmail_rate_limit',
    }),
  },
  {
    tool_prefix: null,
    statuses: new Set([429]),
    message_re: /.*/i,
    build: (ctx) => ({
      code: 'rate_limit_exceeded',
      title: 'Rate limit exceeded',
      plain_english:
        `The tool '${ctx.tool_name}' returned HTTP 429 Too Many Requests. ` +
        'The agent is sending requests faster than the upstream service allows.',
      root_cause: rateLimitRootCause(ctx, ctx.tool_name, "the service's limit"),
      fix_hint:
        'Add a delay between consecutive calls to this tool. If the agent ' +
        'is in a retry loop, implement exponential backoff. Check if a ' +
        'previous step triggered excessive retries.',
      severity: 'warning',
      docs_url: 'https://vorlo.dev/errors/rate_limit_exceeded',
    }),
  },
  // ── Not found ────────────────────────────────────────────────────────
  {
    tool_prefix: null,
    statuses: new Set([404]),
    message_re: /.*/i,
    build: (ctx) => ({
      code: 'resource_not_found',
      title: 'Resource not found',
      plain_english:
        `The tool '${ctx.tool_name}' returned HTTP 404. ` +
        'The resource the agent tried to access does not exist.',
      root_cause: notFoundRootCause(ctx),
      fix_hint:
        'Check that the resource ID or identifier passed to this tool is correct. ' +
        "Look at the previous step's output — the ID may have been formatted incorrectly " +
        'or the resource may have been deleted.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/resource_not_found',
    }),
  },
  // ── Server errors ────────────────────────────────────────────────────
  {
    tool_prefix: null,
    statuses: new Set([500, 502, 503]),
    message_re: /.*/i,
    build: (ctx) => ({
      code: 'upstream_server_error',
      title: 'Upstream service error',
      plain_english:
        `The tool '${ctx.tool_name}' returned HTTP ${ctx.http_status}. ` +
        'The upstream service is experiencing an internal error or outage.',
      root_cause:
        'This is a server-side error from the upstream service — not caused by the agent ' +
        'or its configuration. The service may be temporarily degraded or experiencing an outage.',
      fix_hint:
        'Retry the operation after a short delay. If the error persists, check ' +
        "the upstream service's status page for known outages.",
      severity: 'warning',
      docs_url: 'https://vorlo.dev/errors/upstream_server_error',
    }),
  },
];

// ── Exception-based patterns (no HTTP status) ───────────────────────────

interface ExceptionPattern {
  error_types: Set<string>;
  build: (ctx: TranslateContext) => ErrorDiagnosis;
}

const EXCEPTION_PATTERNS: ExceptionPattern[] = [
  {
    error_types: new Set(['TimeoutError', 'ConnectTimeout', 'ReadTimeout', 'Timeout', 'timeout', 'AbortError']),
    build: (ctx) => ({
      code: 'connection_timeout',
      title: 'Connection timed out',
      plain_english:
        `The tool '${ctx.tool_name}' timed out — the upstream service ` +
        'did not respond within the expected time window.',
      root_cause:
        'The upstream service took too long to respond. This may indicate ' +
        'the service is degraded, overloaded, or the network path has high latency.',
      fix_hint:
        'Check if the upstream service is healthy on its status page. ' +
        'If the tool is performing a large query, consider breaking it into smaller requests. ' +
        'Increase the timeout if the operation is expected to be slow.',
      severity: 'warning',
      docs_url: 'https://vorlo.dev/errors/connection_timeout',
    }),
  },
  {
    error_types: new Set([
      'ConnectionError',
      'ConnectionRefusedError',
      'ConnectionResetError',
      'FetchError',
      'ECONNREFUSED',
      'ECONNRESET',
    ]),
    build: (ctx) => ({
      code: 'connection_refused',
      title: 'Connection refused',
      plain_english:
        `Could not connect to the service behind '${ctx.tool_name}'. ` +
        'The connection was refused or reset.',
      root_cause:
        'The upstream service is either down, unreachable, or actively refusing connections. ' +
        'This could also indicate a firewall or DNS resolution issue.',
      fix_hint:
        'Verify that the service URL is correct. Check the service\'s status page. ' +
        'If this is a self-hosted service, ensure it is running and accessible.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/connection_refused',
    }),
  },
  {
    // JS analogue of Python KeyError — missing property access.
    error_types: new Set(['KeyError']),
    build: (ctx) => ({
      code: 'data_transformation_error',
      title: 'Missing expected data field',
      plain_english:
        `The tool '${ctx.tool_name}' encountered a missing-field error — a required data ` +
        "field was missing from the input or a previous step's output.",
      root_cause: keyErrorRootCause(ctx),
      fix_hint:
        'Check the output of the previous step — the field name or data structure ' +
        'may have changed. Ensure the data passed between steps is in the expected format.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/data_transformation_error',
    }),
  },
  {
    error_types: new Set(['TypeError', 'AttributeError']),
    build: (ctx) => ({
      code: 'data_type_error',
      title: 'Unexpected data type or missing attribute',
      plain_english:
        `The tool '${ctx.tool_name}' received data in an unexpected format. ` +
        'A value was null/undefined when an object was expected, or the wrong type was passed.',
      root_cause: typeErrorRootCause(ctx),
      fix_hint:
        'Check that the previous step returned data in the expected format. ' +
        'A common cause is a previous step returning null/undefined (no data) when ' +
        'a valid object was expected.',
      severity: 'critical',
      docs_url: 'https://vorlo.dev/errors/data_type_error',
    }),
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function translateError(
  toolName: string,
  errorType: string,
  httpStatus: number | null,
  rawMessage: string,
  previousSteps: PreviousStep[] = [],
): ErrorDiagnosis {
  const toolLower = toolName.toLowerCase();
  const toolPrefix = toolLower.includes('_') ? toolLower.split('_')[0]! : toolLower;

  const ctx: TranslateContext = {
    tool_name: toolName,
    tool_prefix: toolPrefix,
    error_type: errorType,
    http_status: httpStatus,
    raw_message: rawMessage,
    previous_steps: previousSteps,
  };

  // Try HTTP-status-based patterns first (more specific patterns first)
  if (httpStatus !== null) {
    for (const pattern of HTTP_PATTERNS) {
      if (pattern.tool_prefix !== null && !toolLower.startsWith(pattern.tool_prefix)) continue;
      if (!pattern.statuses.has(httpStatus)) continue;
      if (!pattern.message_re.test(rawMessage)) continue;
      return pattern.build(ctx);
    }
  }

  // Try exception-type-based patterns
  for (const pattern of EXCEPTION_PATTERNS) {
    if (pattern.error_types.has(errorType)) {
      return pattern.build(ctx);
    }
  }

  return genericDiagnosis(ctx);
}

function genericDiagnosis(ctx: TranslateContext): ErrorDiagnosis {
  const statusPart = ctx.http_status ? ` (HTTP ${ctx.http_status})` : '';
  return {
    code: 'unknown_error',
    title: `Tool '${ctx.tool_name}' failed${statusPart}`,
    plain_english:
      `The tool '${ctx.tool_name}' encountered an error: ` +
      `${truncateKeepTail(ctx.raw_message, 200)}. ` +
      'Vorlo could not match this to a known error pattern.',
    root_cause:
      `Error type: ${ctx.error_type}. ` +
      `Raw message: ${truncateKeepTail(ctx.raw_message, 300)}. ` +
      'This error does not match any known pattern in the Vorlo error catalog. ' +
      'If you see this frequently, report it so we can add a specific diagnosis.',
    fix_hint:
      'Review the raw error message above. Check the tool\'s documentation for ' +
      'this specific error. If this is a recurring issue, contact support and ' +
      'we will add a specific diagnosis for this error pattern.',
    severity: 'warning',
    docs_url: 'https://vorlo.dev/errors/unknown_error',
  };
}
