import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestOrigin } from '../src/request-origin.js';

test('the Origin header, as a site', () => {
  assert.equal(requestOrigin('https://woco.eth.limo', undefined), 'https://woco.eth.limo');
  assert.equal(requestOrigin('http://localhost:1633', undefined), 'http://localhost:1633', 'an own node keeps its port');
});

test('no Origin: the Referer, cut down to its site - never the page someone was on', () => {
  assert.equal(requestOrigin(undefined, 'https://gateway.woco-net.com/bzz/abc/#/event/123?x=1'), 'https://gateway.woco-net.com');
  assert.equal(requestOrigin(undefined, 'https://user:pw@woco.eth.limo/path'), 'https://woco.eth.limo', 'userinfo dropped');
});

test('Origin wins over Referer; "null" and junk fall through; nothing at all is "-"', () => {
  assert.equal(requestOrigin('https://a.example', 'https://b.example/p'), 'https://a.example');
  assert.equal(requestOrigin('null', 'https://b.example/p'), 'https://b.example');
  assert.equal(requestOrigin('not a url', 'also not'), '-');
  assert.equal(requestOrigin(undefined, undefined), '-');
  assert.equal(requestOrigin(['https://a.example', 'https://b.example'], undefined), '-', 'a repeated header is refused');
});

test('only web origins, and nothing that can forge a log line', () => {
  assert.equal(requestOrigin('javascript:alert(1)', undefined), '-');
  assert.equal(requestOrigin('file:///etc/passwd', undefined), '-');
  const out = requestOrigin('https://a.example\n2026-01-01T00:00:00Z - GET /forged', undefined);
  assert.doesNotMatch(out, /[\r\n]/);
  assert.ok(out.length <= 100);
  assert.equal(requestOrigin(`https://${'a'.repeat(300)}.example`, undefined).length, 100);
});
