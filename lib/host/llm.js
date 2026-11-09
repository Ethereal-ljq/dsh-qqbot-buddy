/**
 * host/llm —— 旁路一次性 LLM 调用（记忆提炼 / 知识抽取 / 视觉兜底共用）。
 *
 * v1 有 4 份重复的 llm.stream + BlockAssembler 样板，v2 收口到这里。
 * 注意：这是"旁路生成"，不经过 agent 生命周期（无工具、无 cancel 之外的控制），
 * 只适合短文本抽取；需要工具/多轮的场景必须走 agent。
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';

import { getService, errText } from './services.js';

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * @param {{ctx: object, logger: object}} options
 */
export function createOneShot({ ctx, logger } = {}) {
  /**
   * 生成一段文本。
   * @param {{prompt: string, system?: string, provider?: string, model?: string,
   *          maxTokens?: number, timeoutMs?: number, signal?: AbortSignal, plugin?: string}} args
   * @returns {Promise<{ok: boolean, text: string, error?: string, finish?: object}>}
   */
  async function generate(args = {}) {
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (prompt.trim() === '') return { ok: false, text: '', error: 'empty prompt' };
    const llm = getService(ctx, 'llm');
    if (!llm || typeof llm.stream !== 'function') return { ok: false, text: '', error: 'llm 服务不可用' };

    const text = args.system ? args.system + '\n\n' + prompt : prompt;
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: args.plugin || 'dsh-qqbot-buddy:one-shot' },
    });
    const options = {
      messages: [message],
      maxTokens: Number(args.maxTokens) > 0 ? Number(args.maxTokens) : DEFAULT_MAX_TOKENS,
    };
    if (typeof args.provider === 'string' && args.provider !== '') options.provider = args.provider;
    if (typeof args.model === 'string' && args.model !== '') options.model = args.model;

    const controller = new AbortController();
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error('one-shot timeout')), timeoutMs);
    timer.unref?.();
    let detach;
    if (args.signal) {
      if (args.signal.aborted) controller.abort(args.signal.reason);
      else {
        detach = () => controller.abort(args.signal.reason);
        args.signal.addEventListener('abort', detach, { once: true });
      }
    }
    options.signal = controller.signal;

    try {
      const assembler = new BlockAssembler();
      for await (const chunk of llm.stream(options)) assembler.push(chunk);
      const finish = assembler.finish || null;
      if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
        const messageText = finish.failure && finish.failure.message ? finish.failure.message : '模型调用失败';
        return { ok: false, text: '', error: messageText, finish };
      }
      let blocks;
      try { blocks = assembler.blocks(); } catch (err) {
        return { ok: false, text: '', error: '模型响应不完整: ' + errText(err), finish };
      }
      const output = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (output === '') return { ok: false, text: '', error: '模型未返回文本', finish };
      return { ok: true, text: output, finish };
    } catch (err) {
      logger?.warn?.('one-shot 生成失败: ' + errText(err));
      return { ok: false, text: '', error: errText(err) };
    } finally {
      clearTimeout(timer);
      if (detach && args.signal) { try { args.signal.removeEventListener('abort', detach); } catch { /* ignore */ } }
    }
  }

  return { generate };
}

export default createOneShot;
