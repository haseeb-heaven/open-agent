/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory bridging the model id in the session config to the
 * multi-provider router. A model id with a known provider prefix
 * ("ollama/llama3.1:8b", "groq/llama-3.1-8b-instant") or a registry key
 * from configs/models.toml resolves to an OpenAI-compatible route.
 */

import { getProvider, isProviderAvailable, splitModelId } from './providers.js';
import { readCliEnvAlias } from '../utils/cliEnvAliases.js';
import { getModelRegistry } from './modelRegistry.js';
import type { ModelRegistry } from './modelRegistry.js';
import { OpenAICompatContentGenerator } from './openaiCompatGenerator.js';
import { FreeLLMCatalog, matchCatalogEntry } from './freeCatalog.js';
import { FreeFallbackContentGenerator } from './freeFallback.js';

// Model setup happens for every chat/agent turn. Keep the derived catalog
// alongside the already-cached registry so repeated turns do not reparse TOML
// or allocate the same catalog entries.
const catalogCache = new WeakMap<ModelRegistry, FreeLLMCatalog>();

function getCachedCatalog(registry: ModelRegistry): FreeLLMCatalog {
  const cached = catalogCache.get(registry);
  if (cached) return cached;
  const catalog = FreeLLMCatalog.load(registry);
  catalogCache.set(registry, catalog);
  return catalog;
}

/** True when `modelId` should be routed by the multi-provider layer. */
export function isMultiProviderModel(
  modelId: string,
  registry?: ModelRegistry,
): boolean {
  const id = (modelId ?? '').trim();
  let { provider } = splitModelId(id);
  if (!provider) {
    // Registry keys ("nvidia-nemotron", "openrouter-free", "local-model")
    // carry no prefix but still resolve through configs/models.toml. Prefer
    // the explicit provider tag over the model-id prefix (e.g. openrouter-
    // hosted nvidia/*). "local" is a sentinel meaning "route through Ollama"
    // (see picker.ts / resolve.ts); the registry default model uses it.
    const reg = registry ?? getModelRegistry();
    const key = reg.resolveModelKey(id);
    const cfg = key ? reg.getModel(key) : undefined;
    if (cfg?.provider) {
      provider = getProvider(cfg.provider);
      if (!provider && cfg.provider === 'local')
        provider = getProvider('ollama');
    }
    if (!provider && cfg?.model) provider = splitModelId(cfg.model).provider;
  }
  // Bare gemini/... ids stay on the native Gemini path.
  return provider !== undefined && provider.id !== 'gemini';
}

/**
 * Builds the router for `modelId`, consulting configs/models.toml for
 * api_base/temperature/max_tokens overrides. Returns undefined when the
 * id carries no known provider prefix and no registry entry.
 */
export function createMultiProviderGenerator(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
  registry?: ModelRegistry,
): OpenAICompatContentGenerator | FreeFallbackContentGenerator | undefined {
  const reg = registry ?? getModelRegistry();
  let id = (modelId ?? '').trim();
  let cfg = undefined;

  const key = reg.resolveModelKey(id);
  if (key) {
    cfg = reg.getModel(key);
    if (cfg?.model) id = cfg.model;
  }

  // An explicit provider tag in the registry outranks the id prefix:
  // "openai/gpt-oss-20b:free" with provider = "openrouter" must ship
  // OpenRouter's key to OpenRouter's endpoint, not OpenAI's. The "local"
  // sentinel routes through Ollama (kept in sync with isMultiProviderModel,
  // picker.ts, and resolve.ts).
  const configured = cfg?.provider
    ? (getProvider(cfg.provider) ??
      (cfg.provider === 'local' ? getProvider('ollama') : undefined))
    : undefined;
  const provider = configured ?? splitModelId(id).provider;
  if (!provider) return undefined;
  // Bare gemini/... ids stay on the native Gemini path (must stay in sync
  // with isMultiProviderModel above).
  if (provider.id === 'gemini') return undefined;

  if (!isProviderAvailable(provider, env)) {
    const keyName = provider.envKey ?? 'an API key';
    throw new Error(
      `Model "${modelId}" needs the ${provider.displayName} provider, but ` +
        `${keyName} is not set. Add ${keyName} to your .env (or environment), ` +
        `or start with --free (or use the /model dialog) to pick a model whose key you have.`,
    );
  }

  const generator = new OpenAICompatContentGenerator({
    modelId: id,
    provider,
    apiBase: cfg?.api_base ? String(cfg.api_base) : undefined,
    temperature:
      typeof cfg?.temperature === 'number' ? cfg.temperature : undefined,
    maxTokens: typeof cfg?.max_tokens === 'number' ? cfg.max_tokens : undefined,
    env,
  });

  // Free-catalog models (and any session started with --free) get the
  // runtime fallback chain: rate limits and free-router failures fall
  // through the catalog instead of killing the request.
  const freeSession = readCliEnvAlias('FREE', env) === '1';
  const inCatalog =
    matchCatalogEntry(id, getCachedCatalog(reg), reg) !== undefined;
  if (freeSession || inCatalog) {
    return new FreeFallbackContentGenerator(generator, env, { registry: reg });
  }
  return generator;
}
