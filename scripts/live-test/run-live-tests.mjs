#!/usr/bin/env node
/**
 * Live-testing harness: invokes the real `openagent` CLI as a subprocess
 * (exactly as a human would from a terminal) against real files and real
 * provider API keys, and writes a structured, per-run + per-scenario report.
 *
 * Every filesystem path this script touches comes from an environment
 * variable — nothing is hardcoded. The model matrix is read live from
 * configs/models.toml, so every configured model is covered by default;
 * none are hand-picked or skipped unless the caller explicitly filters.
 *
 * Iteration order: for each scenario, every model runs before moving to the
 * next scenario — so a scenario's report has every model's output for the
 * same prompt sitting side by side, making cross-model comparison direct.
 *
 * Env vars:
 *   LIVE_TEST_MEDIA_DIR      (required) directory of real files to test against,
 *                            e.g. D:\tmp\dummy_media
 *   LIVE_TEST_REPORT_DIR     (default: <repoRoot>/.live-test-reports)
 *   LIVE_TEST_SCENARIOS_FILE (default: scripts/live-test/scenarios.default.json)
 *   LIVE_TEST_CLI_ENTRY      (default: <repoRoot>/packages/cli/dist/index.js)
 *   LIVE_TEST_CWD            (default: LIVE_TEST_MEDIA_DIR) cwd the CLI is run from
 *   LIVE_TEST_APPROVAL_MODE  (default: yolo)
 *   LIVE_TEST_OUTPUT_FORMAT  (default: json)
 *   LIVE_TEST_TIMEOUT_MS     (default: 120000)
 *   LIVE_TEST_CONCURRENCY     (default: 4) bounded number of model processes
 *   LIVE_TEST_TARGET_MS       (default: 5000) latency budget reported per run
 *   LIVE_TEST_MODELS         optional comma list of registry keys (from
 *                            configs/models.toml) to restrict the run to
 *                            (default: every model in the registry)
 *   LIVE_TEST_TIERS          optional comma list of tiers to restrict to
 *                            (e.g. "free_tier,paid")
 *   LIVE_TEST_PROMPT_IDS     optional comma list of prompt ids to restrict to
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllModels } from './model-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[live-test] Missing required environment variable ${name}.\n` +
        `Set it to a real directory before running this harness, e.g.\n` +
        `  ${name}=D:\\tmp\\dummy_media node scripts/live-test/run-live-tests.mjs`,
    );
    process.exit(1);
  }
  return value;
}

function splitEnvList(name) {
  const value = process.env[name];
  if (!value) return undefined;
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

const mediaDir = resolve(requireEnv('LIVE_TEST_MEDIA_DIR'));
if (!existsSync(mediaDir)) {
  console.error(`[live-test] LIVE_TEST_MEDIA_DIR does not exist: ${mediaDir}`);
  process.exit(1);
}

const reportDir = resolve(
  process.env['LIVE_TEST_REPORT_DIR'] || join(repoRoot, '.live-test-reports'),
);
const scenariosFile = resolve(
  process.env['LIVE_TEST_SCENARIOS_FILE'] ||
    join(__dirname, 'scenarios.default.json'),
);
const cliEntry = resolve(
  process.env['LIVE_TEST_CLI_ENTRY'] ||
    join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
);
const runCwd = resolve(process.env['LIVE_TEST_CWD'] || mediaDir);
const approvalMode = process.env['LIVE_TEST_APPROVAL_MODE'] || 'yolo';
const outputFormat = process.env['LIVE_TEST_OUTPUT_FORMAT'] || 'json';
const timeoutMs = Number(process.env['LIVE_TEST_TIMEOUT_MS'] || 120_000);
const targetMs = Number(process.env['LIVE_TEST_TARGET_MS'] || 5_000);

if (!existsSync(cliEntry)) {
  console.error(
    `[live-test] CLI entry point not found at ${cliEntry}.\n` +
      `Build it first with: npm run build --workspace @open-agent/cli\n` +
      `(or set LIVE_TEST_CLI_ENTRY to point at a built entry point).`,
  );
  process.exit(1);
}

if (!existsSync(scenariosFile)) {
  console.error(`[live-test] Scenarios file not found: ${scenariosFile}`);
  process.exit(1);
}

const scenarios = JSON.parse(readFileSync(scenariosFile, 'utf8'));
const modelKeysFilter = splitEnvList('LIVE_TEST_MODELS');
const tiersFilter = splitEnvList('LIVE_TEST_TIERS');
const promptIdsFilter = splitEnvList('LIVE_TEST_PROMPT_IDS');

const allModels = loadAllModels(repoRoot);
const models = allModels.filter((m) => {
  if (modelKeysFilter && !modelKeysFilter.has(m.key)) return false;
  if (tiersFilter && !(m.tier && tiersFilter.has(m.tier))) return false;
  return true;
});
const prompts = scenarios.prompts.filter(
  (p) => !promptIdsFilter || promptIdsFilter.has(p.id),
);

if (models.length === 0 || prompts.length === 0) {
  console.error(
    '[live-test] No models or prompts selected after applying filters — nothing to run.',
  );
  process.exit(1);
}

const requestedConcurrency = Number(
  process.env['LIVE_TEST_CONCURRENCY'] || 4,
);
const concurrency = Math.max(
  1,
  Math.min(
    models.length,
    Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4,
  ),
);

const runId = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace('T', '_')
  .replace('Z', '');
const runDir = join(reportDir, runId);
mkdirSync(runDir, { recursive: true });

function renderPrompt(template) {
  return template.replaceAll('{{MEDIA_DIR}}', mediaDir);
}

// A scenario's prompt often names a specific subfolder of the media dir
// (e.g. "{{MEDIA_DIR}}/images"). If that subfolder doesn't actually exist,
// a model reporting "0 files found" is environmentally correct but useless
// as a signal — flag it instead of letting it read as a silent OK/FAIL.
const MEDIA_SUBDIR_PATTERN = /\{\{MEDIA_DIR\}\}\/([\w.-]+)/g;

function mediaDirNoteFor(template) {
  const missing = [];
  for (const match of template.matchAll(MEDIA_SUBDIR_PATTERN)) {
    const subdir = match[1];
    const candidate = join(mediaDir, subdir);
    if (!existsSync(candidate) && !missing.includes(subdir)) {
      missing.push(subdir);
    }
  }
  if (missing.length === 0) return null;
  return `Referenced media subdir(s) not found under LIVE_TEST_MEDIA_DIR: ${missing.join(', ')} — a model reporting "0 found" here reflects a missing fixture, not a real failure.`;
}

// Heuristic: flag responses that describe a tool call as prose instead of
// invoking it (the regression this whole harness exists to catch).
const NARRATION_PATTERN =
  /\b(run_shell_command|read_file|write_file|list_directory|glob|search_file_content|read_many_files|web_search|web_fetch)\s*\(/;

function runOnce(model, prompt) {
  return new Promise((resolvePromise) => {
    const promptText = renderPrompt(prompt.text);
    const args = [
      cliEntry,
      '--provider',
      model.provider,
      '--model',
      model.key,
      '--prompt',
      promptText,
      '--output-format',
      outputFormat,
      '--approval-mode',
      approvalMode,
    ];

    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: runCwd,
      env: { ...process.env, OPENAGENT_NO_RELAUNCH: 'true' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      let parsed;
      let parseError;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }

      const responseText = parsed?.response ?? '';
      const narrationMatch = NARRATION_PATTERN.exec(responseText);

      const report = {
        runId,
        timestamp: new Date(startedAt).toISOString(),
        modelKey: model.key,
        provider: model.provider,
        model: model.model,
        tier: model.tier,
        promptId: prompt.id,
        promptCategory: prompt.category ?? null,
        input: promptText,
        cwd: runCwd,
        cliEntry,
        approvalMode,
        outputFormat,
        exitCode,
        timedOut,
        durationMs,
        output: parsed?.response ?? null,
        tokens: parsed?.stats ?? null,
        sessionId: parsed?.session_id ?? null,
        cliError: parsed?.error ?? null,
        warnings: parsed?.warnings ?? [],
        parseError: parseError ?? null,
        possibleToolCallNarration: narrationMatch ? narrationMatch[1] : null,
        note: mediaDirNoteFor(prompt.text),
        rawStdout: stdout,
        rawStderr: stderr,
      };

      resolvePromise(report);
    });
  });
}

// A single slow free-tier response shouldn't be graded as a hard FAIL
// indistinguishable from a real crash — retry once on timeout before
// finalizing, and record that a retry happened so the report stays honest
// about flake vs. a genuine repeated failure.
async function runOne(model, prompt) {
  let report = await runOnce(model, prompt);
  let attempts = 1;
  if (report.timedOut) {
    const retryReport = await runOnce(model, prompt);
    attempts = 2;
    report = retryReport;
  }
  report.attempts = attempts;
  report.retried = attempts > 1;

  const scenarioDir = join(runDir, prompt.id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  mkdirSync(scenarioDir, { recursive: true });
  const fileName = `${model.provider}__${model.key}.json`.replace(
    /[^a-zA-Z0-9._-]/g,
    '_',
  );
  writeFileSync(
    join(scenarioDir, fileName),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  return report;
}

function statusOf(report) {
  return report.exitCode === 0 && !report.cliError && !report.timedOut
    ? 'OK'
    : 'FAIL';
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index];
}

async function main() {
  console.log(`[live-test] Media dir:   ${mediaDir}`);
  console.log(`[live-test] CLI entry:   ${cliEntry}`);
  console.log(`[live-test] Run cwd:     ${runCwd}`);
  console.log(`[live-test] Report dir:  ${runDir}`);
  console.log(
    `[live-test] Models:      ${models.length} (of ${allModels.length} in registry)`,
  );
  console.log(`[live-test] Scenarios:   ${prompts.length}`);
  console.log(
    `[live-test] Matrix:      ${models.length} model(s) x ${prompts.length} scenario(s) = ${
      models.length * prompts.length
    } run(s)`,
  );
  console.log('');

  const byScenario = [];
  const allResults = [];
  const matrixStartedAt = Date.now();

  for (const prompt of prompts) {
    console.log(
      `[live-test] === Scenario: ${prompt.id} (${prompt.category ?? 'uncategorized'}) ===`,
    );
    const scenarioResults = [];
    let nextModel = 0;
    const worker = async () => {
      while (nextModel < models.length) {
        const model = models[nextModel++];
        const label = `${model.provider}/${model.key}`;
        process.stdout.write(`[live-test]   ${label} ... `);
        const report = await runOne(model, prompt);
        const status = statusOf(report);
        const flag = report.possibleToolCallNarration
          ? ` (narrated "${report.possibleToolCallNarration}" instead of calling it!)`
          : '';
        const retryFlag = report.retried ? ' (retried after timeout)' : '';
        const noteFlag = report.note ? ' [note: missing media fixture]' : '';
        console.log(`${status}${flag}${retryFlag}${noteFlag}`);
        scenarioResults.push(report);
        allResults.push(report);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const scenarioDir = join(
      runDir,
      prompt.id.replace(/[^a-zA-Z0-9._-]/g, '_'),
    );
    const comparison = {
      promptId: prompt.id,
      category: prompt.category ?? null,
      promptText: renderPrompt(prompt.text),
      models: scenarioResults.map((r) => ({
        provider: r.provider,
        modelKey: r.modelKey,
        model: r.model,
        status: statusOf(r),
        durationMs: r.durationMs,
        tokens: r.tokens,
        output: r.output,
        possibleToolCallNarration: r.possibleToolCallNarration,
        cliError: r.cliError,
        retried: r.retried,
        note: r.note,
      })),
    };
    writeFileSync(
      join(scenarioDir, '_comparison.json'),
      JSON.stringify(comparison, null, 2),
      'utf8',
    );

    const mdLines = [
      `# Scenario: ${prompt.id}`,
      '',
      `- Category: ${prompt.category ?? 'uncategorized'}`,
      `- Prompt: ${comparison.promptText}`,
      '',
      '| Provider | Model | Status | Duration (ms) | Tokens | Output |',
      '| --- | --- | --- | --- | --- | --- |',
      ...comparison.models.map((m) => {
        const flag = m.possibleToolCallNarration ? ' ⚠️ narrated' : '';
        const retryFlag = m.retried ? ' 🔁 retried' : '';
        const tokenSummary = m.tokens ? JSON.stringify(m.tokens) : '';
        const outputPreview = (m.output || m.cliError?.message || '')
          .toString()
          .replace(/\n/g, ' ')
          .slice(0, 200);
        return `| ${m.provider} | ${m.modelKey} | ${m.status}${flag}${retryFlag} | ${m.durationMs} | ${tokenSummary} | ${outputPreview} |`;
      }),
      ...(comparison.models.some((m) => m.note)
        ? ['', `> Note: ${comparison.models.find((m) => m.note).note}`]
        : []),
    ];
    writeFileSync(
      join(scenarioDir, '_comparison.md'),
      mdLines.join('\n'),
      'utf8',
    );

    byScenario.push(comparison);
    console.log('');
  }

  const summary = {
    runId,
    generatedAt: new Date().toISOString(),
    mediaDir,
    cliEntry,
    modelsInRegistry: allModels.length,
    modelsTested: models.length,
    scenariosTested: prompts.length,
    totalRuns: allResults.length,
    matrixWallClockMs: Date.now() - matrixStartedAt,
    configuredConcurrency: concurrency,
    passed: allResults.filter((r) => statusOf(r) === 'OK').length,
    failed: allResults.filter((r) => statusOf(r) === 'FAIL').length,
    narrationRegressions: allResults.filter((r) => r.possibleToolCallNarration)
      .length,
    totalDurationMs: allResults.reduce((sum, r) => sum + r.durationMs, 0),
    p50DurationMs: percentile(
      allResults.map((r) => r.durationMs),
      0.5,
    ),
    p95DurationMs: percentile(
      allResults.map((r) => r.durationMs),
      0.95,
    ),
    overTargetCount: allResults.filter((r) => r.durationMs > targetMs).length,
    targetMs,
    perModelFailureCounts: models
      .map((model) => {
        const runs = allResults.filter((r) => r.modelKey === model.key);
        return {
          modelKey: model.key,
          provider: model.provider,
          tier: model.tier,
          totalRuns: runs.length,
          failed: runs.filter((r) => statusOf(r) === 'FAIL').length,
          narrated: runs.filter((r) => r.possibleToolCallNarration).length,
          avgDurationMs: runs.length
            ? Math.round(
                runs.reduce((sum, r) => sum + r.durationMs, 0) / runs.length,
              )
            : 0,
        };
      })
      .sort((a, b) => b.failed + b.narrated - (a.failed + a.narrated)),
  };

  writeFileSync(
    join(runDir, '_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );

  const mdLines = [
    `# Live test run ${runId}`,
    '',
    `- Media dir: \`${mediaDir}\``,
    `- CLI entry: \`${cliEntry}\``,
    `- Models tested: ${summary.modelsTested} of ${summary.modelsInRegistry} in the registry`,
    `- Scenarios tested: ${summary.scenariosTested}`,
    `- Total runs: ${summary.totalRuns} (passed ${summary.passed}, failed ${summary.failed})`,
    `- Matrix wall-clock: ${summary.matrixWallClockMs} ms at concurrency ${summary.configuredConcurrency}`,
    `- Per-run latency: p50 ${summary.p50DurationMs} ms, p95 ${summary.p95DurationMs} ms`,
    `- Runs over ${summary.targetMs} ms target: ${summary.overTargetCount}`,
    `- Possible tool-call narration regressions: ${summary.narrationRegressions}`,
    '',
    '## Per-model results',
    '',
    '| Model | Provider | Tier | Runs | Failed | Narrated | Avg duration (ms) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summary.perModelFailureCounts.map(
      (m) =>
        `| ${m.modelKey} | ${m.provider} | ${m.tier ?? ''} | ${m.totalRuns} | ${m.failed} | ${m.narrated} | ${m.avgDurationMs} |`,
    ),
    '',
    '## Scenarios',
    '',
    ...byScenario.map(
      (s) =>
        `- \`${s.promptId}\` (${s.category ?? 'uncategorized'}) — see ${s.promptId}/_comparison.md`,
    ),
  ];
  writeFileSync(join(runDir, '_summary.md'), mdLines.join('\n'), 'utf8');

  console.log(
    `[live-test] Done. ${summary.passed}/${summary.totalRuns} passed across ${summary.modelsTested} models x ${summary.scenariosTested} scenarios. Report: ${runDir}`,
  );
  if (summary.narrationRegressions > 0) {
    console.log(
      `[live-test] WARNING: ${summary.narrationRegressions} run(s) show a model narrating a tool call instead of invoking it.`,
    );
  }

  process.exitCode = summary.failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[live-test] Fatal error:', error);
  process.exit(1);
});
