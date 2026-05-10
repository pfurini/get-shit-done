/**
 * Per-agent effective context_window query.
 *
 * Returns 1_000_000 when an agent's resolved model is opus (alias or full ID
 * starting with `claude-opus-`), otherwise the configured `context_window`
 * (default 200_000). Override is unconditional: a configured 200_000 is bumped
 * to 1_000_000 for opus agents, and a configured 2_000_000 is reduced to
 * 1_000_000 for opus agents (#TODO).
 *
 * Consumed by orchestrator workflow MDs (execute-phase.md, plan-phase.md) at
 * subagent dispatch time so prompt-enrichment gates can be evaluated per agent
 * rather than from the single global `context_window` value.
 *
 * @example
 * ```typescript
 * const result = await contextWindowFor(['gsd-planner'], '/project');
 * // { data: { agent_id, model, profile, configured_context_window,
 * //          effective_context_window, opus_detected } }
 * ```
 */

import { GSDError, ErrorClassification } from '../errors.js';
import { loadConfig } from '../config.js';
import { resolveModel } from './config-query.js';
import type { QueryHandler } from './utils.js';

const OPUS_WINDOW = 1_000_000;
const DEFAULT_WINDOW = 200_000;

function isOpusModel(model: string): boolean {
  return model === 'opus' || /^claude-opus-/i.test(model);
}

export const contextWindowFor: QueryHandler = async (args, projectDir, workstream) => {
  const agentId = args[0];
  if (!agentId) {
    throw new GSDError('agent-id required', ErrorClassification.Validation);
  }

  const config = await loadConfig(projectDir, workstream);
  const rawWindow = (config as Record<string, unknown>).context_window;
  const configured =
    typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0
      ? rawWindow
      : DEFAULT_WINDOW;

  const resolved = await resolveModel([agentId], projectDir, workstream);
  const data = resolved.data as Record<string, unknown>;
  const model = String(data.model ?? '');
  const profile = String(data.profile ?? '');
  const opusDetected = isOpusModel(model);
  const effective = opusDetected ? OPUS_WINDOW : configured;

  return {
    data: {
      agent_id: agentId,
      model,
      profile,
      configured_context_window: configured,
      effective_context_window: effective,
      opus_detected: opusDetected,
    },
  };
};
