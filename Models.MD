# Supported Models

This document lists all supported models in **OpenAgent**. The catalog lives in `configs/models.toml` — add your own models/providers by editing that single file, no code changes required.

## Local (default — no API key)
- **Ollama** at `localhost:11434`: every installed model is auto-detected via `/api/tags` (`ollama/llama3.1:8b`, `ollama/codellama:7b`, ...). When no provider is specified, Ollama is tried first automatically.
- **LM Studio** at `localhost:1234`: every loaded model is auto-detected via its OpenAI-compatible `/v1/models` (`lmstudio/<model-id>`).

## OpenAI stable-first (2026)
- `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-mini`, `o4-mini`, `o3`, `o3-mini`, `gpt-4o`, `gpt-4o-mini`, `gpt-4.1-mini`.

## OpenAI legacy aliases
- `gpt-4` -> `gpt-4.1`, `gpt-3.5-turbo` -> `gpt-4o-mini`, `o1-preview` -> `o1`.

## Gemini stable-first (2026)
- `gemini-3.8-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`.

## Gemini preview (optional)
- `gemini-3.1-pro-preview`, `gemini-3-flash-preview`.

## Gemini legacy aliases
- `gemini-pro`, `gemini-1.5-pro`, `gemini-1.5-flash` are remapped to Gemini 2.5 stable models.
- `gemini-3.1-flash-lite-preview` remains an alias for `gemini-3.1-flash-lite` for existing native configurations.

## Anthropic stable-first (2026)
- `claude-opus-5`, `claude-fable-5-1`, `claude-fable-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-opus-4-6`, `claude-haiku-4-5`. Opus 5 and Fable 5.1 are recommended for agentic tasks.

## Anthropic legacy aliases
- `claude-2`, `claude-2.1`, `claude-3-sonnet`, `claude-3-5-sonnet`, `claude-3-7-sonnet` -> `claude-sonnet-4-6`.

## Groq stable-first (2026)
- `groq-llama-3.3`, `groq-llama-3.1-8b`, `groq-gpt-oss-120b`, `groq-gpt-oss-20b`.

## Groq preview (optional)
- `groq-llama-4-scout-preview`.

## Groq legacy aliases
- `groq-mixtral`, `groq-llama2`, `groq-gemma` are remapped to modern Groq models.

## DeepSeek
- `deepseek-chat`, `deepseek-reasoner`, with `deepseek-coder` remapped to `deepseek-chat`.

## NVIDIA (OpenAI-compatible API)
- `nvidia-nemotron` -> `nvidia/nvidia/nemotron-3-super-120b-a12b` (NVIDIA ids carry their own org prefix).

## Z AI (OpenAI-compatible API)
- `z-ai-glm-5` -> `glm-5`.

## OpenRouter (OpenAI-compatible API)
- `openrouter-free` -> `openrouter/free`
- `openrouter-claude-opus-4-6` -> `anthropic/claude-opus-4.6`
- `openrouter-mimo-v2-pro` -> `xiaomi/mimo-v2-pro`
- `openrouter-gpt-5-4` -> `openai/gpt-5.4`
- `openrouter-deepseek-v3-2` -> `deepseek/deepseek-v3.2`
- `openrouter-gpt-oss-20b-free` -> `openai/gpt-oss-20b:free`
- `openrouter-gemma-4-31b-free` -> `google/gemma-4-31b-it:free`
- `openrouter-nemotron-nano-free` -> `nvidia/nemotron-3-nano-30b-a3b:free`
- Legacy aliases (retargeted to valid `:free` ids): `openrouter-mimo-v2-flash-free`, `openrouter-nemotron-3-super-free`, `openrouter-minimax-m2-5-free`
- Removed 2026-07-22 (OpenRouter now returns 404 for these ids): `qwen/qwen3-coder:free`, `meta-llama/llama-3.3-70b-instruct:free`, `tencent/hy3:free` (free promo ended 2026-07-21)

## Cerebras (free public endpoints, rate-limited)
- `cerebras-gpt-oss-120b`, `cerebras-gemma-4-31b`, `cerebras-zai-glm-4.7`.

## Browser Use
- `browser-use-bu-max` -> `bu-max` (session-based model).

## Hugging Face + local
- `hf-meta-llama-3`, `code-llama`, `code-llama-phind`, `mistral-7b`, `wizard-coder`, `star-chat`, `local-model`, `lmstudio-local`.

## Vision + Streaming support matrix

| Provider / model family | Vision | Streaming | Notes |
|---|---|---|---|
| `gpt-4o` / `gpt-4.1` / `gpt-5*` (OpenAI) | ✅ | ✅ | Strong vision quality |
| `gemini-2.5-*` / Gemini previews | ✅ | ✅ | Native multimodal |
| `claude-sonnet` / `claude-opus` / `claude-haiku` (Anthropic) | ✅ | ✅ | Code + image reasoning |
| `llava` / vision models (Ollama, local) | ✅ | ✅ | Local, free |
| LM Studio (local) | ⚠️ | ✅ | Depends on loaded weights |
| `groq/*` | ❌ | ✅ | Text-only today |
| `deepseek-*` | ❌ | ✅ | Text-focused |
| `nvidia/*` | ❌ | ✅ | Text-focused |
| Together AI | ✅ | ✅ | Depends on chosen model |
| HuggingFace Inference | ❌ | ✅ | Rate-limited free |
| `openrouter-free` / OpenRouter `:free` | ⚠️ | ✅ | Depends on routed backend model |
| Cerebras | ⚠️ | ✅ | `cerebras-gemma-4-31b` accepts vision input |
| Z.ai (`glm-5`) | ❌ | ✅ | Text-focused |
| `local-model` (generic local) | ⚠️ | ✅ | Depends on served weights |

Legend: ✅ supported · ⚠️ depends on the concrete backing model · ❌ not supported.

## Choosing a model
- `--pick` / `/pick` — interactive picker: all models grouped by provider with vision, streaming, and API-key availability marked. Detected local models always show as available.
- `--provider <id>` — pin a provider (`ollama`, `lmstudio`, `openai`, `anthropic`, `gemini`, `groq`, `deepseek`, `nvidia`, `together`, `huggingface`, `openrouter`, `cerebras`, `z-ai`).
- `--model / -m <name>` — registry key (`groq-llama-3.1-8b`), free-catalog id, or LiteLLM-style id (`ollama/llama3.1:8b`).
- `--free` — prefer the free catalog rotation; local models are the final fallback of the chain.
- `--byok` / `/byok` — add provider API keys to `.env`; newly available models are shown immediately.

Last verified model baseline: **April 5, 2026**.
