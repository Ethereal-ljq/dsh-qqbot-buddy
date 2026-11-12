/**
 * tools/aliases —— 工具「兼容别名」表。
 *
 * 背景（2026-11-12 线上实测）：模型会按兄弟工具的命名习惯**猜**工具名，
 * 例如看到 qqbot_send_file / qqbot_send_card / qqbot_send_sticker，就把语音工具
 * 猜成 `qqbot_send_voice`（实际叫 `qqbot_speak`），调用返回 `unknown tool`；
 * 同类还有 `qqbot_send_image` / `qqbot_send_emote` / `qqbot_save_emote`。
 *
 * 这里把这类「高概率猜错、但语义明确」的名字注册成**真实可用的别名**：
 * 行为与目标工具完全一致（同一 execute / parameters / output），描述里标注
 * 「兼容别名」并引导优先使用正名。这样模型猜错名也能一次成功，而不是先失败一轮。
 *
 * 约束：
 *   - 只为「本插件自己的工具」建别名（宿主工具不在可控范围内）；
 *   - 别名能力归属必须与目标一致（见 lib/tools/catalog.js 的 PLUGIN_TOOL_CAPABILITIES）；
 *   - 别名只是兼容层，提示词/文档仍然只推荐正名。
 */

/** 别名 → 正名（目标工具必须存在于插件工具清单里）。 */
export const TOOL_ALIASES = Object.freeze({
  qqbot_send_voice: 'qqbot_speak',
  qqbot_send_image: 'qqbot_send_file',
  qqbot_send_emote: 'qqbot_send_sticker',
  qqbot_save_emote: 'qqbot_sticker_save',
});

/** 全部别名名（测试/能力表用）。 */
export const TOOL_ALIAS_NAMES = Object.freeze(Object.keys(TOOL_ALIASES));

/** 某个正名对应的全部别名。 */
export function aliasesForTarget(name) {
  return TOOL_ALIAS_NAMES.filter((alias) => TOOL_ALIASES[alias] === name);
}

/**
 * 由正名工具定义生成别名定义（浅拷贝，execute/parameters/output 全部复用）。
 * @param {object} definition 原始工具定义（name = 正名）
 * @param {string} aliasName 别名
 * @returns {object}
 */
export function createAliasDefinition(definition, aliasName) {
  const target = definition && typeof definition.name === 'string' ? definition.name : '';
  const description = String((definition && definition.description) || '');
  return Object.assign({}, definition, {
    name: aliasName,
    description: '[兼容别名] 与 ' + target + ' 完全等价（模型常把这个工具猜成该名，调用会转发）。'
      + '优先使用 ' + target + '。 ' + description,
  });
}

/**
 * 把一组工具定义展开成「正名 + 全部别名」。
 * @param {object[]} definitions
 * @returns {object[]}
 */
export function expandAliasedDefinitions(definitions) {
  /** @type {object[]} */
  const out = [];
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (!definition || typeof definition.name !== 'string' || definition.name === '') continue;
    out.push(definition);
    for (const aliasName of aliasesForTarget(definition.name)) {
      out.push(createAliasDefinition(definition, aliasName));
    }
  }
  return out;
}

export default { TOOL_ALIASES, TOOL_ALIAS_NAMES, aliasesForTarget, createAliasDefinition, expandAliasedDefinitions };
