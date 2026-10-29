/**
 * persona-cards-store —— 人格卡（人设卡）存储：卡片 CRUD、切换激活、内容比对。
 *
 * 目录布局：
 * - <cwd>/personas/              人格卡目录（cardsDir）
 * - <cwd>/personas/index.json    索引 {version:1, activeId, cards:[{id,name,description,file,createdAt,updatedAt}]}
 * - <cwd>/personas/<id>.md       单张卡的人设正文（id = randomUUID）
 *
 * 设计要点：
 * - 「当前生效」不是凭索引声明，而是实时比较「当前 persona 文件内容」与各卡内容；
 *   index.activeId 只作为提示，内容不一致时一律视为未激活（custom）。
 * - 切换（activate）必须经 personaStore.write()，从而自动获得旧人设备份（<stateDir>/persona-backups）；
 *   本模块绝不经手 persona 文件路径。
 * - 删除卡只删卡文件和索引条目，绝不删除/修改当前 persona 文件。
 * - index.json 与卡文件都用「同目录临时文件 + rename」原子写、权限 0600；坏索引备份为
 *   index.json.corrupt-<ts> 后回退为空索引，不影响其它功能。
 * - 所有公开方法同步返回 {ok:true,...} / {ok:false,error}，不向调用方抛异常（路由层可直接映射 400/500）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const INDEX_VERSION = 1;
const INDEX_FILE = 'index.json';
/** 名称/描述长度上限（按码点计） */
const NAME_MAX = 40;
const DESC_MAX = 200;
/** 单卡正文上限（与 persona-store 的人设上限保持一致） */
const CONTENT_MAX_BYTES = 256 * 1024;
/** 卡文件名必须是有 .md 后缀的纯文件名（防止索引被植入路径） */
const CARD_FILE_EXT = '.md';

const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 按码点数截断，避免切坏 emoji 等代理对 */
function clampChars(text, max) {
  const chars = [...String(text ?? '')];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** 字符串 trim；非字符串一律转空串 */
function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 人设内容归一化：统一换行 + 去掉尾部空白/换行（personaStore.write 会补一个换行） */
function normalizeContent(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n').replace(/\s+$/, '') : '';
}

/** ISO 时间校验；非法则回退「现在」 */
function isoOr(value) {
  if (typeof value === 'string' && value !== '') {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  return new Date().toISOString();
}

/** 卡文件名是否安全：纯文件名、以 .md 结尾、不是隐藏文件 */
function isSafeCardFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  if (file !== path.basename(file)) return false;
  if (file.startsWith('.')) return false;
  if (!file.toLowerCase().endsWith(CARD_FILE_EXT)) return false;
  return !file.includes('/') && !file.includes('\\') && !file.includes('\0');
}

/**
 * 创建人格卡存储。
 * @param {{
 *   settings?: {get: () => any},        // 预留：当前契约固定 cardsDir=<cwd>/personas
 *   personaStore: {read: () => any, write: (text: string) => any},
 *   cwd?: string,
 *   logger?: any,
 * }} options
 */
export function createPersonaCardsStore({ personaStore, cwd, logger } = {}) {
  const log = logger ?? console;
  const baseCwd = typeof cwd === 'string' && cwd.trim() !== '' ? path.resolve(cwd.trim()) : process.cwd();
  const cardsDir = path.join(baseCwd, 'personas');
  const indexPath = path.join(cardsDir, INDEX_FILE);

  /** 人格卡目录绝对路径 */
  const dir = () => cardsDir;

  /** 确保目录存在 */
  function ensureDir() {
    fs.mkdirSync(cardsDir, { recursive: true });
  }

  /** 原子写：同目录临时文件 + rename，权限 0600；失败清理临时文件 */
  function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
      throw err;
    }
  }

  /** 读取当前人设（personaStore 缺失/异常时降级为空人设） */
  function readPersona() {
    try {
      if (personaStore && typeof personaStore.read === 'function') {
        const data = personaStore.read();
        if (isObj(data)) {
          const text = typeof data.text === 'string' ? data.text : '';
          return {
            text,
            path: typeof data.path === 'string' ? data.path : '',
            exists: data.exists === true || text !== '',
            chars: text.length,
          };
        }
      }
    } catch (err) {
      log.warn?.('persona-cards: 读取当前人设失败:', err && err.message);
    }
    return { text: '', path: '', exists: false, chars: 0 };
  }

  /** 归一化索引数据结构（丢弃非法条目，绝不因坏数据崩溃） */
  function normalizeIndex(raw) {
    const cards = [];
    const seen = new Set();
    const list = isObj(raw) && Array.isArray(raw.cards) ? raw.cards : [];
    for (const item of list) {
      if (!isObj(item)) continue;
      const id = trimText(item.id);
      if (id === '' || id.length > 80 || seen.has(id)) continue;
      if (!/^[A-Za-z0-9-]+$/.test(id)) continue;
      const name = clampChars(trimText(item.name), NAME_MAX);
      if (name === '') continue;
      const file = typeof item.file === 'string' && item.file !== '' ? item.file : `${id}.md`;
      if (!isSafeCardFile(file)) continue;
      seen.add(id);
      cards.push({
        id,
        name,
        description: clampChars(trimText(item.description), DESC_MAX),
        file,
        createdAt: isoOr(item.createdAt),
        updatedAt: isoOr(item.updatedAt),
      });
    }
    const storedActiveId = isObj(raw) && typeof raw.activeId === 'string' ? raw.activeId : null;
    return { version: INDEX_VERSION, activeId: storedActiveId, cards };
  }

  /** 读取索引；不存在返回空索引；损坏时备份并回退空索引 */
  function loadIndex() {
    let raw;
    try {
      raw = fs.readFileSync(indexPath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.('persona-cards: 读取 index.json 失败:', err.message);
      return { version: INDEX_VERSION, activeId: null, cards: [] };
    }
    try {
      return normalizeIndex(JSON.parse(raw));
    } catch (err) {
      log.warn?.('persona-cards: index.json 损坏，回退为空索引:', err && err.message);
      try {
        fs.renameSync(indexPath, `${indexPath}.corrupt-${Date.now()}`);
      } catch { /* 备份失败不影响主流程 */ }
      return { version: INDEX_VERSION, activeId: null, cards: [] };
    }
  }

  /** 原子保存索引（activeId 只保留指向现存卡的值） */
  function saveIndex(index) {
    ensureDir();
    const activeId = index.cards.some((card) => card.id === index.activeId) ? index.activeId : null;
    const payload = {
      version: INDEX_VERSION,
      activeId,
      cards: index.cards.map((card) => ({
        id: card.id,
        name: card.name,
        description: card.description,
        file: card.file,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      })),
    };
    atomicWrite(indexPath, JSON.stringify(payload, null, 2) + '\n');
    index.activeId = activeId;
  }

  /** 卡文件绝对路径（file 已在 normalizeIndex 中校验为纯文件名） */
  function cardPath(card) {
    return path.join(cardsDir, card.file);
  }

  /** 读取卡正文；文件缺失返回 undefined（调用方据此标记 missing） */
  function readCardContent(card) {
    try {
      const stat = fs.statSync(cardPath(card));
      if (!stat.isFile()) return undefined;
      if (stat.size > CONTENT_MAX_BYTES) {
        log.warn?.(`persona-cards: 卡文件超过 ${CONTENT_MAX_BYTES} 字节，按缺失处理: ${card.file}`);
        return undefined;
      }
      return fs.readFileSync(cardPath(card), 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.(`persona-cards: 读取卡文件失败（${card.file}）:`, err.message);
      return undefined;
    }
  }

  /**
   * 构建卡片视图并计算当前激活卡：
   * - 优先沿用 index.activeId（若其内容仍与当前人设一致），否则取第一张内容一致的卡；
   * - active 标记唯一；缺文件的卡 active=false、missing=true。
   */
  function buildViews(index, persona) {
    const personaNorm = normalizeContent(persona.text);
    const contents = new Map();
    for (const card of index.cards) contents.set(card.id, readCardContent(card));

    const matches = index.cards.filter((card) => {
      const content = contents.get(card.id);
      return content !== undefined && normalizeContent(content) === personaNorm && personaNorm !== '';
    });
    let activeId = null;
    if (matches.length > 0) {
      const hinted = matches.find((card) => card.id === index.activeId);
      activeId = (hinted ?? matches[0]).id;
    }
    const views = index.cards.map((card) => {
      const content = contents.get(card.id);
      return {
        id: card.id,
        name: card.name,
        description: card.description,
        file: card.file,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        chars: content === undefined ? 0 : content.length,
        active: card.id === activeId,
        missing: content === undefined,
      };
    });
    return { views, activeId };
  }

  /** 当前激活状态对象（list/detectActive 共用） */
  function activeState(index, persona) {
    const { views, activeId } = buildViews(index, persona);
    return {
      activeId,
      active: activeId,
      custom: activeId === null,
      cards: views,
      persona,
    };
  }

  /** 统一失败返回（记录日志，不抛异常） */
  function fail(message, err) {
    const error = message instanceof Error ? message.message : String(message ?? '未知错误');
    log.warn?.('persona-cards:', error, err && err.message ? err.message : '');
    return { ok: false, error };
  }

  /** 校验名称：必填、<= NAME_MAX 码点 */
  function validateName(value) {
    const name = trimText(value);
    if (name === '') return { ok: false, error: '人格卡名称不能为空' };
    if ([...name].length > NAME_MAX) return { ok: false, error: `人格卡名称不能超过 ${NAME_MAX} 个字符` };
    return { ok: true, name };
  }

  /** 校验描述：可空、<= DESC_MAX 码点 */
  function validateDescription(value, fallback = '') {
    if (value === undefined || value === null) return { ok: true, description: fallback };
    const description = trimText(value);
    if ([...description].length > DESC_MAX) return { ok: false, error: `人格卡描述不能超过 ${DESC_MAX} 个字符` };
    return { ok: true, description };
  }

  /** 校验正文：非空、<= CONTENT_MAX_BYTES */
  function validateContent(value) {
    if (typeof value !== 'string') return { ok: false, error: '人格卡内容必须是字符串' };
    if (value.trim() === '') return { ok: false, error: '人格卡内容不能为空' };
    if (Buffer.byteLength(value, 'utf8') > CONTENT_MAX_BYTES) {
      return { ok: false, error: `人格卡内容不能超过 ${Math.floor(CONTENT_MAX_BYTES / 1024)}KB` };
    }
    return { ok: true, content: value };
  }

  /** 写卡正文（覆盖时同样原子写） */
  function writeCardFile(card, content) {
    ensureDir();
    atomicWrite(cardPath(card), content);
  }

  /**
   * 删除前把卡文件复制到 <personas>/.trash/，返回副本路径（失败返回空串）。
   * 目的：误删可恢复——人格卡没有其他备份来源。
   * @param {object} card
   * @returns {string}
   */
  function backupCardBeforeDelete(card) {
    const source = cardPath(card);
    if (!fs.existsSync(source)) return '';
    const trashDir = path.join(cardsDir, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = String(card.name || card.id).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40);
    const target = path.join(trashDir, card.id + '__' + safeName + '__' + stamp + '.md');
    fs.copyFileSync(source, target);
    return target;
  }

  /** 删除单个卡文件（不存在忽略） */
  function removeCardFile(card) {
    try {
      fs.unlinkSync(cardPath(card));
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }

  /** 按 id 找卡与视图 */
  function findCard(index, id) {
    const key = trimText(id);
    if (key === '') return undefined;
    return index.cards.find((card) => card.id === key);
  }

  // ── 公开 API ────────────────────────────────────────────────
  /**
   * 列出现有人格卡与当前激活状态（只读，不写盘）。
   * @returns {{ok:true, dir:string, indexFile:string, activeId:string|null, active:string|null,
   *   custom:boolean, cardCount:number, persona:object, cards:Array}}
   */
  function list() {
    try {
      const index = loadIndex();
      const persona = readPersona();
      const state = activeState(index, persona);
      return {
        ok: true,
        dir: cardsDir,
        indexFile: indexPath,
        activeId: state.activeId,
        active: state.active,
        custom: state.custom,
        cardCount: state.cards.length,
        // client/client.js 把 data.persona 当「人设文件路径」字符串展示；
        // 更完整的信息放在 personaInfo 里，避免破坏 UI 现有读取方式。
        persona: persona.path || '',
        personaInfo: { path: persona.path, exists: persona.exists, chars: persona.chars },
        cards: state.cards,
      };
    } catch (err) {
      return fail('列出现有人格卡失败', err);
    }
  }

  /**
   * 新建人格卡。
   * @param {{name:string, description?:string, content?:string}} input
   *   content 省略时取当前 persona 内容（等价于「把当前人设存为新卡」）。
   */
  function create(input = {}) {
    try {
      const nameCheck = validateName(input.name);
      if (!nameCheck.ok) return nameCheck;
      const descCheck = validateDescription(input.description);
      if (!descCheck.ok) return descCheck;

      let content;
      if (input.content === undefined || input.content === null) {
        const persona = readPersona();
        if (!persona.exists || persona.text.trim() === '') {
          return fail('当前人设为空，无法保存为卡片');
        }
        content = persona.text;
      } else {
        content = input.content;
      }
      const contentCheck = validateContent(content);
      if (!contentCheck.ok) return contentCheck;

      const index = loadIndex();
      const now = new Date().toISOString();
      const card = {
        id: randomUUID(),
        name: nameCheck.name,
        description: descCheck.description,
        file: '',
        createdAt: now,
        updatedAt: now,
      };
      card.file = `${card.id}${CARD_FILE_EXT}`;

      writeCardFile(card, contentCheck.content);
      index.cards.push(card);
      try {
        const state = activeState(index, readPersona());
        index.activeId = state.activeId;
        saveIndex(index);
        const view = state.cards.find((item) => item.id === card.id);
        return { ok: true, card: view ?? card, activeId: state.activeId, custom: state.custom };
      } catch (err) {
        // 索引落盘失败：回滚刚写的卡文件，避免目录里留下孤儿文件
        index.cards.pop();
        try { removeCardFile(card); } catch { /* 回滚失败忽略 */ }
        throw err;
      }
    } catch (err) {
      return fail('创建人格卡失败', err);
    }
  }

  /**
   * 更新人格卡：可改 name/description/content。
   *
   * 语义（v0.11 修正）：
   * - 更新的是「当前激活卡」且写了 content 时，**同时把人设文件写成同一内容**，
   *   保持「卡 == 人设」这个激活不变量。否则覆盖后内容不一致，激活状态会漂移到
   *   另一张卡（或变成 custom），用户看到的就是"覆盖没生效"。
   * - 更新的是非激活卡：只改卡文件，不动人设。
   */
  function update(id, patch = {}) {
    try {
      const index = loadIndex();
      const card = findCard(index, id);
      if (!card) return fail('人格卡不存在');
      if (!isObj(patch)) return fail('更新内容不合法');

      const hasName = patch.name !== undefined;
      const hasDesc = patch.description !== undefined;
      const hasContent = patch.content !== undefined;
      if (!hasName && !hasDesc && !hasContent) return fail('没有可更新的字段');

      let nextName = card.name;
      if (hasName) {
        const check = validateName(patch.name);
        if (!check.ok) return check;
        nextName = check.name;
      }
      let nextDesc = card.description;
      if (hasDesc) {
        const check = validateDescription(patch.description);
        if (!check.ok) return check;
        nextDesc = check.description;
      }

      // 先判定「更新前」这张卡是不是激活卡（用旧内容比对人设）
      const before = activeState(index, readPersona());
      const wasActive = before.activeId === id;

      if (hasContent) {
        const check = validateContent(patch.content);
        if (!check.ok) return check;
        writeCardFile(card, check.content);
        // 激活卡改了内容 -> 人设同步写成同一份，维持「卡 == 人设」的激活不变量。
        // 必须走 personaStore.write()：它负责旧人设备份（<stateDir>/persona-backups）。
        if (wasActive && personaStore && typeof personaStore.write === 'function') {
          const written = personaStore.write(check.content);
          if (!written || written.ok !== true) {
            return fail((written && written.error) || '同步写入当前人设失败');
          }
        }
      }

      card.name = nextName;
      card.description = nextDesc;
      card.updatedAt = new Date().toISOString();
      const state = activeState(index, readPersona());
      index.activeId = state.activeId;
      saveIndex(index);
      const view = state.cards.find((item) => item.id === card.id);
      return { ok: true, card: view ?? card, activeId: state.activeId, custom: state.custom };
    } catch (err) {
      return fail('更新人格卡失败', err);
    }
  }

  /**
   * 激活人格卡：读卡内容 → personaStore.write（自动备份旧人设）→ 记录 activeId。
   */
  function activate(id) {
    try {
      const index = loadIndex();
      const card = findCard(index, id);
      if (!card) return fail('人格卡不存在');
      const content = readCardContent(card);
      if (content === undefined) return fail('人格卡文件缺失，无法使用');
      if (!personaStore || typeof personaStore.write !== 'function') {
        return fail('人设存储不可用，无法切换人格卡');
      }
      const written = personaStore.write(content);
      if (!written || written.ok !== true) {
        return fail((written && written.error) || '写入当前人设失败');
      }
      index.activeId = card.id;
      saveIndex(index);
      const view = activeState(index, readPersona()).cards.find((item) => item.id === card.id);
      return {
        ok: true,
        card: view ?? card,
        activeId: card.id,
        active: true,
        custom: false,
        backup: written.backup,
      };
    } catch (err) {
      return fail('切换人格卡失败', err);
    }
  }

  /**
   * 删除人格卡：只删卡文件与索引条目，绝不删除/修改当前 persona 文件。
   */
  function deleteCard(id) {
    try {
      const index = loadIndex();
      const card = findCard(index, id);
      if (!card) return fail('人格卡不存在');
      const wasActive = activeState(index, readPersona()).activeId === card.id;

      // 软删除：先留一份到 .trash/，再删正式文件。
      // 人格卡一旦误删，内容无法从别处恢复（不像人设有 persona-backups），所以这里兜一层。
      let trashed = '';
      try {
        trashed = backupCardBeforeDelete(card);
      } catch (err) {
        log.warn?.('persona-cards: 删除前备份失败（继续删除）:', err && err.message);
      }
      removeCardFile(card);
      index.cards = index.cards.filter((item) => item.id !== card.id);
      const state = activeState(index, readPersona());
      index.activeId = state.activeId;
      saveIndex(index);
      return {
        ok: true,
        id: card.id,
        name: card.name,
        wasActive,
        activeId: state.activeId,
        custom: state.custom,
        ...(trashed !== '' ? { trashPath: trashed } : {}),
      };
    } catch (err) {
      return fail('删除人格卡失败', err);
    }
  }

  /**
   * 读取单张人格卡正文（供设置页「查看/编辑卡内容」使用）。
   * @param {string} id 卡 id
   */
  function read(id) {
    try {
      const index = loadIndex();
      const card = findCard(index, id);
      if (!card) return fail('人格卡不存在');
      const content = readCardContent(card);
      if (content === undefined) return fail('人格卡文件缺失');
      const isActive = activeState(index, readPersona()).activeId === card.id;
      return {
        ok: true,
        id: card.id,
        name: card.name,
        description: card.description,
        content,
        chars: content.length,
        updatedAt: card.updatedAt,
        active: isActive,
      };
    } catch (err) {
      return fail('读取人格卡内容失败', err);
    }
  }

  /**
   * 把当前 persona 内容存为新人格卡（并自动成为激活卡）。
   */
  function importCurrent(input = {}) {
    const result = create({ name: input.name, description: input.description });
    if (!result.ok) return result;
    return { ...result, custom: false, activeId: result.card.id, active: true };
  }

  /**
   * 重新检测当前激活卡（内容比对）；activeId 变化时持久化 index.json。
   */
  function detectActive() {
    try {
      const index = loadIndex();
      const persona = readPersona();
      const state = activeState(index, persona);
      const changed = index.activeId !== state.activeId;
      if (changed) {
        index.activeId = state.activeId;
        saveIndex(index);
      }
      const activeCard = state.cards.find((card) => card.active) ?? null;
      return { ok: true, activeId: state.activeId, card: activeCard, custom: state.custom, changed };
    } catch (err) {
      return fail('检测人格卡激活状态失败', err);
    }
  }

  return {
    dir,
    list,
    read,
    create,
    update,
    activate,
    delete: deleteCard,
    importCurrent,
    detectActive,
  };
}
