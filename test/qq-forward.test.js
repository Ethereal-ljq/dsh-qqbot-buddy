/**
 * forward-render —— 合并转发（聊天记录）的归属重排。
 *
 * 背景（真实案例）：朝咱 转发了一条含照片的聊天记录，模型随后把照片当成「院」发的。
 * 根因是 QQ 把「转发者」和「记录内作者」平铺成两层同格式的名字：
 *
 *   [朝咱 (BE0E...)] [群聊的聊天记录]
 *   === 消息 1 ===
 *   [发送者] 溯
 *
 * 本文件锁住重排后的行为：转发者必须显式声明、记录内作者不得与外层同格式、长 URL 必须剔除。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleAgentBody } from '../lib/qq/inbound.js';
import { FORWARD_END, FORWARD_START, hasForwardRecord, renderForwardRecord } from '../lib/qq/forward-render.js';

/** 真实案例一：朝咱 转发了一条只有图片的记录（2026-11-11 08:09 UTC）。 */
const CHAOZAN_RECORD = [
  '[群聊的聊天记录]',
  '=== 消息 1 ===',
  '[发送者] 溯',
  '[附件1] 类型:图片 文件名:EE55FF19.jpg 尺寸:1215x1728 大小:256.3KB URL=https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=aaa&rkey=SECRET123&spec=0',
  '',
  '=== 消息 2 ===',
  '[发送者] 溯',
  '[附件1] 类型:图片 文件名:88C70C25.jpg 尺寸:1215x1728 大小:227.5KB URL=https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=bbb&rkey=SECRET456&spec=0',
].join('\n');

/** 真实案例二：三层嵌套的合并转发（2026-11-11 11:22 浮沉 转发）。 */
const NESTED_RECORD = [
  '[群聊的聊天记录]',
  '=== 消息 1 ===',
  '[发送者] 圣君金子羽',
  '[附件1] 类型:图片 文件名:A.jpg 尺寸:864x1920 大小:293.3KB URL=https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=SECRET1',
  '',
  '=== 消息 2 ===',
  '[消息内容] [群聊的聊天记录]',
  '[发送者] 圣君金子羽',
  '[消息类型] 合并转发消息',
  '[关联消息]',
  '--- 第1条 ---',
  '    [消息内容] [群聊的聊天记录]',
  '    [发送者] 耶薯鸡督',
  '    [消息类型] 合并转发消息',
  '    [关联消息]',
  '    --- 第1条 ---',
  '        [消息内容] 那确实没啥天赋',
  '        [发送者] 无光的擢升法令',
  '    --- 第2条 ---',
  '        [附件1] 类型:图片 文件名:B.jpg URL=https://multimedia.nt.qq.com.cn/download?fileid=b&rkey=SECRET2',
  '        [发送者] 无光的擢升法令',
].join('\n');

const groupMsg = (content, extra = {}) => ({
  kind: 'group', content, messageId: 'm-fw', msgType: 0,
  senderId: 'BE0E92E87302C4D16668C1D825636DD8', senderName: '朝咱', ...extra,
});

test('hasForwardRecord：只认 [群聊的聊天记录]', () => {
  assert.equal(hasForwardRecord(CHAOZAN_RECORD), true);
  assert.equal(hasForwardRecord('普通文本'), false);
  assert.equal(hasForwardRecord(''), false);
  assert.equal(hasForwardRecord(undefined), false);
});

test('重排后显式声明「转发者」与「记录内作者不是转发者」', () => {
  const out = renderForwardRecord(CHAOZAN_RECORD, { senderName: '朝咱', senderId: 'BE0E92E87302C4D16668C1D825636DD8' });
  assert.ok(out.startsWith(FORWARD_START), '应以转发块开始标记开头，实际: ' + out.slice(0, 60));
  assert.ok(out.includes('转发者=朝咱'), '必须点明转发者是朝咱，实际: ' + out);
  assert.ok(out.includes('不是 朝咱'), '必须声明记录内作者不是转发者，实际: ' + out);
  assert.ok(out.includes('记录内作者: 溯'), '必须列出记录内作者，实际: ' + out);
  assert.ok(out.endsWith(FORWARD_END), '应以转发块结束标记收尾');
});

test('记录内作者降级为缩进行，不与外层同格式', () => {
  const out = renderForwardRecord(CHAOZAN_RECORD, { senderName: '朝咱', senderId: 'BE0E92E87302C4D16668C1D825636DD8' });
  // 内层不得残留 [发送者] 这种和外层 [昵称 (openid)] 近似的写法
  assert.ok(!out.includes('[发送者]'), '内层 [发送者] 标记必须被改写，实际: ' + out);
  assert.ok(out.includes('└ 作者 溯：一张图片'), '内层作者应作为缩进行出现');
  // 连续同作者的图片行各自独立，不合并成一条
  assert.equal(out.split('作者 溯：一张图片').length - 1, 2);
});

test('附件只报类型与数量，不把几百字符的下载 URL 塞进上下文', () => {
  const out = renderForwardRecord(CHAOZAN_RECORD, { senderName: '朝咱' });
  assert.ok(!out.includes('rkey='), '下载 token 不得进入模型上下文，实际: ' + out);
  assert.ok(!out.includes('multimedia.nt.qq.com.cn'), '下载域名不得出现');
  assert.ok(!out.includes('文件名:'), '文件名对模型无意义，不应保留');
});

test('三层嵌套：子记录挂在对应的转发条目下，层级不丢', () => {
  const out = renderForwardRecord(NESTED_RECORD, { senderName: '浮沉', senderId: '91F6D2C123897689574A4186D18D2527' });
  assert.ok(out.includes('转发者=浮沉'));
  assert.ok(out.includes('（转发了下面这些）'), '转发条目本身应标明是转发而不是空内容，实际: ' + out);
  assert.ok(out.includes('作者 耶薯鸡督'), '第二层作者必须出现');
  assert.ok(out.includes('作者 无光的擢升法令'), '第三层作者必须出现');
  assert.ok(out.includes('那确实没啥天赋'), '最内层正文必须保留');
  // 缩进随层级递增：第三层比第二层更深
  const line = (kw) => out.split('\n').find((l) => l.includes(kw)) || '';
  const indent = (s) => s.length - s.trimStart().length;
  assert.ok(indent(line('作者 耶薯鸡督')) > indent(line('作者 圣君金子羽')), '耶薯鸡督 应比 圣君金子羽 缩进更深');
  assert.ok(indent(line('作者 无光的擢升法令')) > indent(line('作者 耶薯鸡督')), '无光的擢升法令 应比 耶薯鸡督 缩进更深');
});

test('群聊当前消息：转发者标签在外层，记录内容在转发块内', () => {
  const body = assembleAgentBody({ message: groupMsg(CHAOZAN_RECORD), state: {}, scope: 'group' });
  assert.ok(body.startsWith('[朝咱 (BE0E92E87302C4D16668C1D825636DD8)] '), '外层发言人标签必须在最前，实际: ' + body.slice(0, 80));
  assert.ok(body.includes('转发者=朝咱'));
  assert.ok(body.includes('不是 朝咱'));
});

test('群历史里的转发也走同一套重排', () => {
  const history = [{ senderName: '浮沉', senderId: '91F6D2C123897689574A4186D18D2527', content: CHAOZAN_RECORD, messageId: 'm-h' }];
  const body = assembleAgentBody({ message: groupMsg('这啥', { messageId: 'm-now' }), state: { history }, scope: 'group' });
  assert.ok(body.includes('[Chat history begins]'));
  assert.ok(body.includes('转发者=浮沉'), '历史条目里的转发必须同样重排，实际: ' + body);
  assert.ok(body.includes('不是 浮沉'));
});

test('非转发消息完全不受影响', () => {
  const body = assembleAgentBody({ message: groupMsg('普通一句话'), state: {}, scope: 'group' });
  assert.equal(body, '[朝咱 (BE0E92E87302C4D16668C1D825636DD8)] 普通一句话');
  assert.ok(!body.includes(FORWARD_START));
});

test('转发块之前的内容（如卡片行）保留在块外', () => {
  const out = renderForwardRecord('前缀内容\n' + CHAOZAN_RECORD, { senderName: '朝咱' });
  assert.ok(out.startsWith('前缀内容'), '转发块之前的正文不能被吞掉，实际: ' + out.slice(0, 40));
  assert.ok(out.indexOf('前缀内容') < out.indexOf(FORWARD_START));
});
