/**
 * Unit tests for the context-window-for query handler.
 *
 * Verifies the per-agent override rule: when an agent's resolved model is opus
 * (alias or `claude-opus-*` ID), the effective context_window is forced to
 * 1_000_000 regardless of the configured global value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GSDError } from '../errors.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gsd-cw-'));
  await mkdir(join(tmpDir, '.planning'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeConfig(cfg: Record<string, unknown>): Promise<void> {
  await writeFile(join(tmpDir, '.planning', 'config.json'), JSON.stringify(cfg));
}

describe('contextWindowFor', () => {
  it('returns 1M for explicit opus override', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_overrides: { 'gsd-executor': 'opus' } });
    const result = await contextWindowFor(['gsd-executor'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.effective_context_window).toBe(1_000_000);
    expect(data.opus_detected).toBe(true);
    expect(data.model).toBe('opus');
  });

  it('returns configured value for explicit sonnet override', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({
      model_overrides: { 'gsd-executor': 'sonnet' },
      context_window: 200_000,
    });
    const result = await contextWindowFor(['gsd-executor'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.effective_context_window).toBe(200_000);
    expect(data.opus_detected).toBe(false);
  });

  it('returns 1M for profile=quality on agents whose golden tier is opus', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_profile: 'quality' });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.model).toBe('opus');
    expect(data.effective_context_window).toBe(1_000_000);
  });

  it('returns configured value for profile=balanced on agents whose balanced tier is sonnet', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_profile: 'balanced' });
    const result = await contextWindowFor(['gsd-verifier'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.model).toBe('sonnet');
    expect(data.effective_context_window).toBe(200_000);
  });

  it('forces 1M for opus even when configured context_window is 200_000', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({
      context_window: 200_000,
      model_overrides: { 'gsd-planner': 'opus' },
    });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.configured_context_window).toBe(200_000);
    expect(data.effective_context_window).toBe(1_000_000);
  });

  it('preserves a custom configured value for non-opus agents', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({
      context_window: 350_000,
      model_profile: 'balanced',
    });
    const result = await contextWindowFor(['gsd-executor'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.model).toBe('sonnet');
    expect(data.effective_context_window).toBe(350_000);
  });

  it('reduces a configured 2M to 1M for opus agents (literal-1M rule)', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({
      context_window: 2_000_000,
      model_overrides: { 'gsd-planner': 'opus' },
    });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.configured_context_window).toBe(2_000_000);
    expect(data.effective_context_window).toBe(1_000_000);
  });

  it('detects opus from a full Anthropic model ID', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_overrides: { 'gsd-planner': 'claude-opus-4-7' } });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.opus_detected).toBe(true);
    expect(data.effective_context_window).toBe(1_000_000);
  });

  it('detects opus from the 1M variant model ID', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_overrides: { 'gsd-planner': 'claude-opus-4-7[1m]' } });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.opus_detected).toBe(true);
    expect(data.effective_context_window).toBe(1_000_000);
  });

  it('does not detect opus from a non-Claude model ID', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_overrides: { 'gsd-planner': 'gpt-5.4' } });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.opus_detected).toBe(false);
    expect(data.effective_context_window).toBe(200_000);
  });

  it('returns configured value when resolve_model_ids is omit (model is empty)', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({
      resolve_model_ids: 'omit',
      model_profile: 'quality',
    });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.model).toBe('');
    expect(data.opus_detected).toBe(false);
    expect(data.effective_context_window).toBe(200_000);
  });

  it('returns configured value when profile is inherit (model is "inherit")', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ model_profile: 'inherit' });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.model).toBe('inherit');
    expect(data.opus_detected).toBe(false);
    expect(data.effective_context_window).toBe(200_000);
  });

  it('detects opus on non-Claude runtimes via the alias (codex+quality → opus)', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeConfig({ runtime: 'codex', model_profile: 'quality' });
    const result = await contextWindowFor(['gsd-planner'], tmpDir);
    const data = result.data as Record<string, unknown>;
    expect(data.model).toBe('opus');
    expect(data.opus_detected).toBe(true);
    expect(data.effective_context_window).toBe(1_000_000);
  });

  it('throws GSDError when no agent id is provided', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await expect(contextWindowFor([], tmpDir)).rejects.toThrow(GSDError);
  });

  it('respects workstream override (root=balanced, ws/frontend=quality → 1M)', async () => {
    const { contextWindowFor } = await import('./context-window.js');
    await writeFile(
      join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );
    await mkdir(join(tmpDir, '.planning', 'workstreams', 'frontend'), { recursive: true });
    await writeFile(
      join(tmpDir, '.planning', 'workstreams', 'frontend', 'config.json'),
      JSON.stringify({ model_profile: 'quality' }),
    );

    const rootResult = await contextWindowFor(['gsd-executor'], tmpDir);
    const rootData = rootResult.data as Record<string, unknown>;
    expect(rootData.model).toBe('sonnet');
    expect(rootData.effective_context_window).toBe(200_000);

    const wsResult = await contextWindowFor(['gsd-executor'], tmpDir, 'frontend');
    const wsData = wsResult.data as Record<string, unknown>;
    expect(wsData.model).toBe('opus');
    expect(wsData.effective_context_window).toBe(1_000_000);
  });
});
