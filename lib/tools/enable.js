/**
 * tools/enable —— 元工具 qqbot_enable：点亮「被动工具」。
 *
 * 为什么需要：被动工具默认不声明（零 schema 成本），模型就看不见它们。
 * 路由（lib/tools/activation.js 的关键词匹配）能覆盖大部分情况，漏判时由模型自己
 * 用本工具按「能力组」或「工具名」点亮，下一个 step 即可调用。
 *
 * 它自己必须常驻（档位 active），否则就成了"要开锁先得有钥匙"。
 */
import {
  ACTIVATION_GROUPS, groupOfTool, isToolAllowed, toolsOfGroup,
} from './catalog.js';
import { addActivation, capabilityEnabled, groupAvailable } from './activation.js';
import { groupLabels, usageLinesForGroups } from './index-guide.js';

/** 工具名。 */
export const ENABLE_TOOL_NAME = 'qqbot_enable';

const DESCRIPTION = 'Load one on-demand capability for the rest of this session when the user clearly needs it '
  + 'but the matching tools are not loaded yet (they are listed in the tool index without full schemas, to save context). '
  + 'Pass a capability id (imagegen, voice, card, vision, workspace, shell, jobs, canvas, knowledge_write) '
  + 'or a tool name. On success the result lists the tools and their exact arguments; '
  + 'they become callable on your next step. Do not call this for tools that are already loaded.';

/** 组 id → 空格分隔的工具名（给模型看）。 */
function groupToolNames(groupId) {
  return toolsOfGroup(groupId);
}

/**
 * 构造元工具定义。
 * @param {object} deps
 * @param {object} deps.manager 会话适配器（findByAgent）
 * @param {() => object} [deps.getSettings]
 * @param {(agent: object) => Set<string>} [deps.knownTools] 当前 agent 已知工具名
 * @param {(agent: object) => Promise<void>} [deps.onActivated] 点亮后刷新宿主工具限制
 * @param {object} [deps.logger]
 * @returns {object} 工具定义
 */
export function createEnableTool({ manager, runtime, getSettings, knownTools, onActivated, logger } = {}) {
  const log = logger || console;
  return {
    name: ENABLE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'On-demand capability id (imagegen, voice, card, vision, workspace, shell, jobs, canvas, knowledge_write) '
            + 'or a tool name.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional tool names to enable.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          groups: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.message === 'string' ? value.message : '已处理' }],
    },
    async execute(args, exec) {
      const runCtx = args && typeof args === 'object' ? args : {};
      const agent = exec && exec.agent !== undefined ? exec.agent : undefined;
      const record = manager && typeof manager.findByAgent === 'function' ? manager.findByAgent(agent) : null;
      if (!record || typeof record.peer !== 'string') {
        throw new Error('qqbot_enable: 找不到当前 QQ 会话');
      }
      const settings = typeof getSettings === 'function' ? (getSettings() || {}) : {};
      const known = typeof knownTools === 'function' ? knownTools(agent) : null;

      const wantedGroups = new Set();
      const wantedTools = new Set();
      const pushArg = (value) => {
        const name = typeof value === 'string' ? value.trim() : '';
        if (name === '') return;
        if (ACTIVATION_GROUPS[name]) { wantedGroups.add(name); return; }
        const group = groupOfTool(name);
        if (group !== undefined) { wantedGroups.add(group); return; }
        wantedTools.add(name);
      };
      pushArg(runCtx.capability);
      if (Array.isArray(runCtx.tools)) for (const item of runCtx.tools) pushArg(item);

      // 逐组校验（2026-11-14）：能力没开 / 本机没装工具 → 不开，并返回真实原因。
      // 以前不管能不能用都回「已开启能力」，模型下一步调用的就是不存在的东西。
      const enabledGroups = [];
      const rejectedGroups = [];
      for (const id of wantedGroups) {
        const group = ACTIVATION_GROUPS[id];
        if (!group) { rejectedGroups.push({ id, reason: '没有这个能力组' }); continue; }
        // 策略判定统一走 groupAvailable：白名单显式放行可以越过能力开关（isToolAllowed 第 2 条）。
        // 只查能力开关会误报「能力未开启」，而工具页那边显示的是「索引中」，模型和用户看到两种说法。
        if (!groupAvailable({ settings, groupId: id })) {
          const capability = group.capability;
          const reason = capability && !capabilityEnabled(settings, capability)
            ? '能力「' + capability + '」未开启，且白名单没有单独放行这组工具'
            : '工具策略没有放行这组工具';
          rejectedGroups.push({ id, reason });
          continue;
        }
        const names = groupToolNames(id).filter((name) => {
          try { return isToolAllowed({ settings, name }); } catch { return false; }
        });
        const usable = known === null ? names : names.filter((name) => known.has(name));
        if (usable.length === 0) {
          rejectedGroups.push({ id, reason: '本机没有装载这组工具（插件未安装或未启用）' });
          continue;
        }
        enabledGroups.push({ id, names: usable });
      }

      const accepted = [];
      const rejected = [];
      for (const name of wantedTools) {
        if (known === null || known.has(name)) accepted.push(name);
        else rejected.push(name);
      }

      if (enabledGroups.length === 0 && accepted.length === 0) {
        const reasons = rejectedGroups.map((item) => (ACTIVATION_GROUPS[item.id]?.label || item.id) + '：' + item.reason);
        let message;
        if (reasons.length > 0) {
          message = '没有开启任何能力。' + reasons.join('；')
            + '。不要臆造工具名，也不要说已开启；需要这个能力就如实告诉用户现在不可用。';
        } else if (rejected.length > 0) {
          message = '没有可开启的工具：' + rejected.join('、') + ' 不在当前工具清单里。';
        } else {
          message = '没有指定要开启的能力。可用组：' + Object.keys(ACTIVATION_GROUPS).join('、') + '。';
        }
        return { ok: false, groups: [], tools: [], message };
      }

      const groupIds = enabledGroups.map((item) => item.id);
      addActivation(runtime, record.peer, { groups: groupIds, tools: accepted });
      // 宿主全局工具走 restrict：点亮后立刻重放，下一步才看得到
      if (typeof onActivated === 'function') {
        try { await onActivated(agent); } catch (err) {
          log.warn?.('qqbot_enable: 刷新宿主工具限制失败: ' + (err && err.message));
        }
      }

      // 用法卡：把「下个 step 才出现在请求里」的 schema 压成一行签名，避免模型靠猜参数再失败一次
      const usageNames = [...new Set(enabledGroups.flatMap((item) => item.names).concat(accepted))];
      const usage = usageLinesForGroups(groupIds, { names: usageNames });
      const parts = [];
      if (groupIds.length > 0) parts.push('已开启：' + groupLabels(groupIds).join('、'));
      if (accepted.length > 0) parts.push('已点名工具：' + accepted.join('、'));
      let message = parts.join('；') + '。下一步可直接调用（不要重复调用 qqbot_enable）：';
      if (usage.length > 0) message += '\n' + usage.join('\n');
      const notes = [];
      if (rejectedGroups.length > 0) {
        notes.push('未开启：' + rejectedGroups
          .map((item) => (ACTIVATION_GROUPS[item.id]?.label || item.id) + '（' + item.reason + '）')
          .join('；'));
      }
      if (rejected.length > 0) notes.push('忽略不存在的工具：' + rejected.join('、'));
      if (notes.length > 0) message += '\n' + notes.join('；') + '。';
      log.info?.('qqbot_enable: ' + message.replace(/\n/g, ' | '));
      return {
        ok: true,
        groups: groupIds,
        tools: accepted,
        message,
      };
    },
  };
}

/**
 * 包装成工厂返回数组（与其它 create*Tools 一致）。
 * @param {object} deps 见 createEnableTool
 * @returns {object[]}
 */
export function createEnableTools(deps = {}) {
  try {
    return [createEnableTool(deps)];
  } catch (err) {
    deps.logger?.warn?.('qqbot_enable 工具定义构造失败: ' + (err && err.message));
    return [];
  }
}

export default createEnableTools;
