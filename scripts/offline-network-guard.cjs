/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

function isLoopback(host) {
  const normalized = String(host ?? '').toLowerCase();
  const ipv6 = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
  if (normalized === 'localhost' || (ipv6 === '::1' && net.isIP(ipv6) === 6))
    return true;
  if (net.isIP(normalized) !== 4) return false;
  return Number(normalized.split('.')[0]) === 127;
}

function hostOnly(host) {
  let value = String(host ?? '').trim();
  try {
    if (value.includes('://')) value = new URL(value).hostname;
  } catch {
    return '<redacted>';
  }
  value = value.replace(/^.*@/, '').replace(/^\[|\]$/g, '');
  if (net.isIP(value)) return value.toLowerCase();
  if (value.includes(':')) value = value.slice(0, value.indexOf(':'));
  return /^[a-z0-9.-]{1,253}$/i.test(value) ? value.toLowerCase() : '<redacted>';
}

function recordDeniedHost(host) {
  const evidencePath = process.env.GEMINI_OFFLINE_NETWORK_ATTEMPTS;
  if (evidencePath) {
    fs.appendFileSync(evidencePath, `${JSON.stringify({ host: hostOnly(host) })}\n`);
  }
}

function assertLoopback(host) {
  if (!isLoopback(host)) {
    recordDeniedHost(host);
    throw new Error('Offline E2E network guard blocked non-loopback connection');
  }
}

function checkUrl(input) {
  let url;
  try {
    url = new URL(input instanceof URL ? input.href : String(input));
  } catch {
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:')
    assertLoopback(url.hostname);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  checkUrl(input instanceof Request ? input.url : input);
  return originalFetch.call(this, input, init);
};

for (const module of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function guardedRequest(...args) {
      const first = args[0];
      if (typeof first === 'string' || first instanceof URL) checkUrl(first);
      else if (first && typeof first === 'object') {
        const protocol =
          first.protocol || `${module === https ? 'https:' : 'http:'}`;
        if (protocol === 'http:' || protocol === 'https:')
          assertLoopback(first.hostname || first.host || '');
      }
      return original.apply(this, args);
    };
  }
}

for (const method of ['connect', 'createConnection']) {
  const original = net[method];
  net[method] = function guardedSocket(...args) {
    const first = args[0];
    if (typeof first === 'object' && first !== null) {
      const host = first.host || first.hostname;
      if (host) assertLoopback(host);
    } else if (typeof args[1] === 'string') {
      assertLoopback(args[1]);
    } else if (typeof args[1] === 'object' && args[1] !== null) {
      const host = args[1].host || args[1].hostname;
      if (host) assertLoopback(host);
    }
    return original.apply(this, args);
  };
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  const options = args[0];
  if (typeof options === 'object' && options !== null) {
    const host = options.host || options.hostname;
    if (host) assertLoopback(host);
  } else if (typeof args[1] === 'string') {
    assertLoopback(args[1]);
  } else if (typeof args[1] === 'object' && args[1] !== null) {
    const host = args[1].host || args[1].hostname;
    if (host) assertLoopback(host);
  }
  return originalSocketConnect.apply(this, args);
};

module.exports = { assertLoopback, isLoopback };
