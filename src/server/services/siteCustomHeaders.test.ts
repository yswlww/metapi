import { describe, expect, it } from 'vitest';
import { Headers } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from './siteCustomHeaders.js';

describe('mergeHeadersWithSiteCustomHeaders', () => {
  it('preserves legacy request priority while keeping site user-agent authoritative by default', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({
        Authorization: 'Bearer site-default',
        'User-Agent': 'site-agent',
        'X-Client-Version': 'site-version',
      }),
      {
        authorization: 'Bearer request-token',
        'user-agent': 'request-agent',
        'x-client-version': 'request-version',
      },
    ));

    expect(merged.get('authorization')).toBe('Bearer request-token');
    expect(merged.get('user-agent')).toBe('site-agent');
    expect(merged.get('x-client-version')).toBe('request-version');
  });

  it('lets site custom headers override ordinary request headers when site priority is enabled', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({
        Authorization: 'Bearer site-default',
        'User-Agent': 'site-agent',
        'X-Client-Version': 'site-version',
      }),
      {
        authorization: 'Bearer request-token',
        'user-agent': 'request-agent',
        'x-client-version': 'request-version',
        'x-trace-id': 'trace-1',
      },
      { priority: 'site' },
    ));

    expect(merged.get('authorization')).toBe('Bearer request-token');
    expect(merged.get('user-agent')).toBe('site-agent');
    expect(merged.get('x-client-version')).toBe('site-version');
    expect(merged.get('x-trace-id')).toBe('trace-1');
  });

  it.each([
    ['x-api-key', 'request-api-key', 'site-api-key'],
    ['x-goog-api-key', 'request-google-key', 'site-google-key'],
  ])('keeps request %s credentials authoritative with site priority', (headerName, requestValue, siteValue) => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      { [headerName]: siteValue },
      { [headerName]: requestValue },
      { priority: 'site' },
    ));

    expect(merged.get(headerName)).toBe(requestValue);
  });

  it('keeps request transport and credential headers authoritative with site priority', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      {
        Connection: 'close',
        'Content-Length': '999',
        Cookie: 'site-cookie=1',
        Host: 'site.example.com',
        'Proxy-Authorization': 'Basic site-proxy',
        'Transfer-Encoding': 'chunked',
      },
      {
        connection: 'keep-alive',
        'content-length': '42',
        cookie: 'request-cookie=1',
        host: 'request.example.com',
        'proxy-authorization': 'Basic request-proxy',
        'transfer-encoding': 'identity',
      },
      { priority: 'site' },
    ));

    expect(Object.fromEntries(merged.entries())).toMatchObject({
      connection: 'keep-alive',
      'content-length': '42',
      cookie: 'request-cookie=1',
      host: 'request.example.com',
      'proxy-authorization': 'Basic request-proxy',
      'transfer-encoding': 'identity',
    });
  });

  it('returns the original request headers when no site custom headers are configured', () => {
    const requestHeaders = { 'X-Trace-Id': 'trace-1' };

    expect(mergeHeadersWithSiteCustomHeaders(null, requestHeaders)).toBe(requestHeaders);
  });
});
