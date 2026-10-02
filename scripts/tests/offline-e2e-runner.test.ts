/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { get as httpGet, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { once } from 'node:events';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const guard = resolve('scripts/offline-network-guard.cjs');
const require = createRequire(import.meta.url);

describe('offline E2E network guard', () => {
  it('allows only explicit localhost and parsed IPv4 loopback addresses', () => {
    const hosts = [
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '127.0.0.1',
      '127.255.255.255',
      '127.attacker.example',
      '127.0.0.1.example',
      '127.0.0.1.2',
      'example.com',
    ];
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { isLoopback } = require(${JSON.stringify(guard)}); console.log(JSON.stringify(${JSON.stringify(hosts)}.map(isLoopback)));`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('records a blocked attempt even when application code catches it', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'offline-network-guard-'));
    const evidencePath = resolve(tempDir, 'attempts.jsonl');
    try {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `require(${JSON.stringify(guard)}); try { fetch('https://user:secret@127.attacker.example/path'); } catch {}`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GEMINI_OFFLINE_NETWORK_ATTEMPTS: evidencePath,
          },
        },
      );
      expect(result.status).toBe(0);
      const evidence = readFileSync(evidencePath, 'utf8');
      expect(evidence).toContain('127.attacker.example');
      expect(evidence).not.toContain('https://');
      expect(evidence).not.toContain('secret');
      expect(evidence).not.toContain('/path');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks non-loopback requests before any transport can run', () => {
    for (const attempt of [
      `fetch('https://example.com')`,
      `fetch('https://127.attacker.example')`,
      `fetch(new Request('https://example.com'))`,
      `require('node:http').request('http://example.com')`,
      `require('node:http').get('http://example.com')`,
      `require('node:https').request('https://example.com')`,
      `require('node:https').get('https://example.com')`,
      `require('node:net').connect(443, 'example.com')`,
      `require('node:net').createConnection(443, 'example.com')`,
      `new (require('node:net').Socket()).connect(443, 'example.com')`,
    ]) {
      const transports = `
        const net = require('node:net');
        const http = require('node:http');
        const https = require('node:https');
        const reachedTransport = new Error('LOCAL_TRANSPORT_SENTINEL');
        globalThis.fetch = () => { throw reachedTransport; };
        for (const module of [http, https]) {
          module.request = () => { throw reachedTransport; };
          module.get = () => { throw reachedTransport; };
        }
        net.connect = () => { throw reachedTransport; };
        net.createConnection = () => { throw reachedTransport; };
        net.Socket.prototype.connect = () => { throw reachedTransport; };
      `;
      const result = spawnSync(
        process.execPath,
        ['-e', `${transports} require(${JSON.stringify(guard)}); ${attempt}`],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/blocked non-loopback connection/);
      expect(result.stderr).not.toContain('LOCAL_TRANSPORT_SENTINEL');
    }
  });

  it('allows fetch to a local loopback fixture server', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address');
      require(guard);
      const response = await globalThis.fetch(
        `http://127.0.0.1:${address.port}`,
      );
      expect(await response.text()).toBe('ok');
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });

  it('allows local HTTP and socket transports to reach loopback', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture address');
    require(guard);
    const requestBody = (request) =>
      new Promise((resolveBody, rejectBody) => {
        request.on('response', (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolveBody(body));
        });
        request.on('error', rejectBody);
        request.end();
      });
    const socketConnected = new Promise((resolveSocket, rejectSocket) => {
      const socket = netConnect(address.port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolveSocket();
      });
      socket.once('error', rejectSocket);
    });
    try {
      expect(
        await requestBody(httpGet(`http://127.0.0.1:${address.port}`)),
      ).toBe('ok');
      expect(
        await requestBody(httpRequest(`http://127.0.0.1:${address.port}`)),
      ).toBe('ok');
      await socketConnected;
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});
