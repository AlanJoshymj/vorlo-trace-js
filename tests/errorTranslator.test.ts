import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { translateError } from '../src/errorTranslator.js';

describe('translateError — HTTP patterns', () => {
  it('diagnoses a Stripe auth error (401)', () => {
    const d = translateError(
      'stripe_charge_card',
      'HTTPError',
      401,
      'Invalid API key provided',
    );
    assert.equal(d.code, 'stripe_auth_error');
    assert.equal(d.severity, 'critical');
  });

  it('falls back to generic 401 for an unknown tool', () => {
    const d = translateError('acme_widget', 'HTTPError', 401, 'nope');
    assert.equal(d.code, 'auth_unauthorized');
  });

  it('diagnoses a 403 as forbidden, not unauthorized', () => {
    const d = translateError('acme_widget', 'HTTPError', 403, 'denied');
    assert.equal(d.code, 'auth_forbidden');
  });

  it('routes gmail 429 to the gmail-specific rate limit', () => {
    const d = translateError('gmail_send', 'HTTPError', 429, 'slow down');
    assert.equal(d.code, 'gmail_rate_limit_exceeded');
  });

  it('routes a non-gmail 429 to the generic rate limit', () => {
    const d = translateError('slack_post', 'HTTPError', 429, 'slow down');
    assert.equal(d.code, 'rate_limit_exceeded');
  });

  it('diagnoses 404 as resource not found', () => {
    const d = translateError('get_customer', 'HTTPError', 404, 'missing');
    assert.equal(d.code, 'resource_not_found');
  });

  it('diagnoses 5xx as upstream server error', () => {
    for (const s of [500, 502, 503]) {
      assert.equal(translateError('x', 'HTTPError', s, 'boom').code, 'upstream_server_error');
    }
  });
});

describe('translateError — exception patterns', () => {
  it('maps timeout-family errors', () => {
    assert.equal(translateError('x', 'TimeoutError', null, '').code, 'connection_timeout');
    assert.equal(translateError('x', 'AbortError', null, '').code, 'connection_timeout');
  });

  it('maps connection-family errors', () => {
    assert.equal(translateError('x', 'ConnectionError', null, '').code, 'connection_refused');
    assert.equal(translateError('x', 'FetchError', null, '').code, 'connection_refused');
  });

  it('maps KeyError and extracts the missing field into the root cause', () => {
    const d = translateError('transform', 'KeyError', null, "'customer_segment'");
    assert.equal(d.code, 'data_transformation_error');
    assert.match(d.root_cause, /customer_segment/);
  });

  it('maps TypeError', () => {
    const d = translateError('x', 'TypeError', null, 'got null');
    assert.equal(d.code, 'data_type_error');
  });
});

describe('translateError — fallback', () => {
  it('returns unknown_error when nothing matches', () => {
    const d = translateError('weird_tool', 'SomeNovelError', null, 'totally novel');
    assert.equal(d.code, 'unknown_error');
    assert.equal(d.severity, 'warning');
    assert.match(d.title, /weird_tool/);
  });

  it('includes HTTP status in the generic title when present but unmatched', () => {
    const d = translateError('x', 'WeirdError', 418, "I'm a teapot");
    assert.match(d.title, /HTTP 418/);
  });
});

describe('translateError — cross-step context', () => {
  it('surfaces previous tools in an auth root cause', () => {
    const d = translateError('stripe_refund', 'HTTPError', 403, 'authentication failed', [
      { tool_name: 'get_charge', tool_type: 'sensor', status: 'success' },
    ]);
    assert.match(d.root_cause, /get_charge/);
  });
});
