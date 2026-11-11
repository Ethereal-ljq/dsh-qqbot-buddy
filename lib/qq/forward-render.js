/**
 * forward-render —— QQ「聊天记录」合并转发消息的结构化重排。
 *
 * 问题（真实案例）：
 *   QQ 服务端下发的合并转发 content 是**平铺多层身份**的文本。外层 [昵称 (openid)] 是
 *   真正发这条消息的人，内层 [发送者] 才是被转发记录里的原作者。两者格式相近、层级仅靠缩进，
 *   模型经常把内层作者当成发言者，把「朝咱转发的」说成「院发的」。
 *
 * 真实格式（来自线上消息，注意缩进与嵌套）：
 *
 *   [群聊的聊天记录]
 *   === 消息 1 ===
 *   [发送者] 圣君金子羽
 *   [附件1] 类型:图片 文件名:xxx.jpeg ...
 *
 *   === 消息 2 ===
 *   [消息内容] [群聊的聊天记录]
 *   [发送者] 圣君金子羽
 *   [消息类型] 合并转发消息
 *   [关联消息]
 *   --- 第1条 ---
 *       [消息内容] [群聊的聊天记录]
 *       [发送者] 耶薯鸡督
 *       [消息类型] 合并转发消息
 *       [关联消息]
 *       --- 第1条 ---
 *           [消息内容] 那确实没啥天赋
 *           [发送者] 无光的擢升法令
 *
 *   嵌套可达 3+ 层，每层用 4 个空格缩进，内层用 `--- 第N条 ---`，外层用 `=== 消息 N ===`。
 *
 * 处理：
 *   1. 外层明确声明「转发者是谁」「记录内作者不是转发者」
 *   2. 内层作者降级为缩进行，不再与外层同格式
 *   3. 附件压成「一张图片」，不回写几百字符的 rkey URL
 *   4. 保留嵌套层级，但限制递归深度，避免上下文爆炸
 */

/** 转发块起始标记（QQ 服务端固定文案）。 */
const RECORD_HEADER = '[群聊的聊天记录]';
/** 外层单条消息分隔：=== 消息 1 === */
const MESSAGE_SEP = /^===\s*消息\s*(\d+)\s*===$/;
/** 内层单条消息分隔：--- 第1条 --- */
const NESTED_SEP = /^---\s*第\s*(\d+)\s*条\s*---$/;
/** 记录内作者：[发送者] 昵称 */
const SENDER_LINE = /^\[发送者\]\s*(.*)$/;
/** 记录内正文：[消息内容] xxx */
const CONTENT_LINE = /^\[消息内容\]\s*(.*)$/;
/** 记录内类型：[消息类型] 合并转发消息 */
const TYPE_LINE = /^\[消息类型\]\s*(.*)$/;
/** 记录内附件：[附件1] 类型:图片 文件名:... */
const ATTACHMENT_LINE = /^\[附件(\d+)\]\s*类型:([^\s]+)/;
/** 嵌套容器的开始标记 */
const NESTED_OPEN = '[关联消息]';

/** 转发块开始标记。 */
export const FORWARD_START = '[转发内容开始]';
/** 转发块结束标记。 */
export const FORWARD_END = '[转发内容结束]';

/** 最多展开几层嵌套：再深的只报条数，避免几百行图片把上下文撑爆。 */
export const MAX_DEPTH = 3;

/**
 * 内容里是否含合并转发块。
 * @param {string} text
 * @returns {boolean}
 */
export function hasForwardRecord(text) {
  return typeof text === 'string' && text.includes(RECORD_HEADER);
}

/**
 * 把附件行压成简短描述（不回写几百字符的 rkey URL）。
 * @param {RegExpMatchArray} match
 * @returns {string}
 */
function describeAttachment(match) {
  const kind = (match[2] || '').trim();
  return kind === '' ? '[附件]' : '[图片]'.replace('图片', kind) === '[图片]' ? '一张图片' : '一个' + kind;
}

/** 计算一行前缀的空格缩进。 */
function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * 把转发正文解析成树。
 *
 * 规则：
 *   - 缩进更深 = 更内层
 *   - `--- 第N条 ---` 开启该缩进层级的一个条目
 *   - `=== 消息 N ===` 开启最外层条目
 *   - `[关联消息]` 表示「本条是合并转发」，其后的更深缩进行是子记录
 *
 * @param {string[]} lines
 * @returns {Array<{author:string, texts:string[], attachments:string[], children:Array}>}
 */
function parseTree(lines) {
  /** @type {Array<{depth:number, container:{author:string,texts:string[],attachments:string[],children:Array}}>} */
  const stack = [];
  /** @type {Array} */
  const root = [];

  /**
   * 新建一个条目并挂到正确的父级。
   * depth 是「层级序号」：0 = 最外层 === 消息 N ===，1 = 第一层嵌套的 --- 第N条 ---，依此类推。
   * 挂载时弹出所有 depth >= 当前 的容器，剩下的栈顶就是它的父级。
   */
  const pushEntry = (depth) => {
    const entry = { author: '', texts: [], attachments: [], children: [], isForward: false };
    // 关键：弹出所有 depth >= 当前 的容器，剩下的栈顶才是父级。
    // 用 >= 而不是 > ：同级条目之间互相是兄弟，不能嵌套进上一个同类条目。
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    // 注意：栈里只保留「比当前层级浅」的祖先，因此 level=1 的条目
    // 会挂到最近的外层消息（level=0），level=2 的挂到最近的 level=1 下。
    if (stack.length === 0) root.push(entry);
    else stack[stack.length - 1].container.children.push(entry);
    return entry;
  };

  /**
   * 把原文的缩进字节数换算成层级序号。
   * QQ 的嵌套条目用固定缩进（实测 4 字节 = 一层），必须按 /4 归一，
   * 否则第一个嵌套条目会算出 depth=5 而挂不到 depth=0 的外层消息下。
   */
  const depthOfIndent = (spaces) => Math.floor(spaces / 4);

  let current = null;
  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    const depth = indentOf(rawLine);
    const line = rawLine.trim();

    if (MESSAGE_SEP.test(line)) {
      current = pushEntry(0);
      continue;
    }
    if (NESTED_SEP.test(line)) {
      // 缩进 0 的 --- 第N条 --- 属于最外层消息（depth 1）；缩进 4 的属于 depth 2，依此类推
      const level = depthOfIndent(depth) + 1;
      current = pushEntry(level);
      stack.push({ depth: level, container: current });
      continue;
    }
    if (!current) {
      current = pushEntry(0);
    }
    if (line === NESTED_OPEN) {
      // 本条是「合并转发」：把它登记成一个容器，后续更深缩进的条目挂到它下面。
      // 用「当前条目本身」当容器，避免多造一层空壳。
      if (current) {
        current.isForward = true;
        const parentDepth = stack.length > 0 ? stack[stack.length - 1].depth : 0;
        stack.push({ depth: parentDepth, container: current });
      }
      continue;
    }

    const sender = line.match(SENDER_LINE);
    if (sender) {
      const name = sender[1].trim();
      if (name !== '') current.author = name;
      continue;
    }
    const content = line.match(CONTENT_LINE);
    if (content) {
      const value = content[1].trim();
      // 「[消息内容] [群聊的聊天记录]」表示这一条本身又是一次转发，不当正文
      if (value !== '' && value !== RECORD_HEADER && !value.includes(RECORD_HEADER)) {
        current.texts.push(value);
      }
      continue;
    }
    const type = line.match(TYPE_LINE);
    if (type) continue; // 「合并转发消息」已经由结构本身表达
    const att = line.match(ATTACHMENT_LINE);
    if (att) {
      current.attachments.push(describeAttachment(att));
      continue;
    }
    // 无标记的普通正文行
    current.texts.push(line);
  }
  return root;
}

/**
 * 渲染一个条目（含它的子树）。
 * @param {object} entry
 * @param {number} depth
 * @param {string[]} out
 */
function renderEntry(entry, depth, out) {
  const pad = '  '.repeat(depth + 1);
  const author = entry.author !== '' ? entry.author : '(未知作者)';
  const parts = [];
  if (entry.texts.length > 0) {
    const joined = entry.texts.join(' / ');
    parts.push(joined.length > 120 ? joined.slice(0, 120) + '…' : joined);
  }
  if (entry.attachments.length > 0) {
    // 相同描述合并计数：一张图片 ×3
    const counts = new Map();
    for (const a of entry.attachments) counts.set(a, (counts.get(a) || 0) + 1);
    for (const [k, n] of counts) parts.push(n > 1 ? k + ' ×' + n : k);
  }
  let body = parts.length > 0 ? parts.join(' ') : '';
  if (entry.isForward && body === '') body = '（转发了下面这些）';
  else if (body === '') body = '（空）';
  out.push(pad + '└ 作者 ' + author + '：' + body);

  if (entry.children.length > 0) {
    if (depth + 1 >= MAX_DEPTH) {
      out.push(pad + '  └ （更内层还有 ' + entry.children.length + ' 条，已省略）');
      return;
    }
    for (const child of entry.children) renderEntry(child, depth + 1, out);
  }
}

/**
 * 把转发记录正文重排成带归属声明的块。没有转发块时原样返回。
 *
 * @param {string} body 当前消息正文（不含外层发送者标签；可含卡片行等前置内容）
 * @param {object} [opts]
 * @param {string} [opts.senderName] 外层发言人昵称（真正发消息的人）
 * @param {string} [opts.senderId] 外层发言人 openid
 * @returns {string}
 */
export function renderForwardRecord(body, opts = {}) {
  const text = typeof body === 'string' ? body : '';
  const idx = text.indexOf(RECORD_HEADER);
  if (idx < 0) return text;

  const head = text.slice(0, idx).trimEnd();
  const entries = parseTree(text.slice(idx + RECORD_HEADER.length).split('\n'));

  const name = typeof opts.senderName === 'string' ? opts.senderName.trim() : '';
  const openid = typeof opts.senderId === 'string' ? opts.senderId.trim() : '';
  const who = name !== '' ? name : (openid !== '' ? openid.slice(0, 8) : '某人');
  const whoTag = name !== '' && openid !== '' ? name + ' (' + openid + ')' : who;

  const out = [];
  if (head !== '') out.push(head);
  out.push(FORWARD_START + ' 转发者=' + whoTag + '：这是 ' + who
    + ' 转发来的聊天记录，下面每条的作者是别人，不是 ' + who);

  const authors = [...new Set(entries.flatMap(function collect(e) {
    const acc = e.author !== '' ? [e.author] : [];
    for (const c of e.children) acc.push(...collect(c));
    return acc;
  }))];
  if (authors.length > 0) out.push('  └ 记录内作者: ' + authors.join('、'));

  for (const entry of entries) renderEntry(entry, 0, out);
  out.push(FORWARD_END);
  return out.join('\n');
}
