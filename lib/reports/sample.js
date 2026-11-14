/**
 * reports/sample —— 模板预览用的示例日报 payload。
 *
 * 与 daily.js 生成的真实 payload 同形状（version 1），只是数据固定：
 * 控制台的「模板预览」用它渲染，不需要真实群聊记录，也不读写数据库。
 * 文案刻意写成真实群聊口味，方便看模板排版（不要 lorem）。
 */
import { dayBounds } from './daily.js';

const SAMPLE_TOTAL = 186;
const SAMPLE_SPEAKERS = 23;

/** 示例 Top 发言人（与真实统计的 topSpeakers 同形状）。 */
const TOP_SPEAKERS = [
  { name: '阿离', count: 41 },
  { name: '栖迟', count: 33 },
  { name: '小满', count: 28 },
  { name: '老白', count: 22 },
  { name: '江雾', count: 19 },
  { name: '糖豆', count: 16 },
  { name: '半盏', count: 12 },
  { name: '青柠', count: 9 },
];

/** 24 小时消息分布：19 点（下标 19）最热闹。 */
const HOURS = [
  2, 1, 0, 0, 0, 0, 1, 3, 5, 6, 4, 3, 7, 9, 6, 5, 8, 11, 14, 18, 16, 9, 5, 3,
];

/** 示例报告正文：3 个话题 + 3 条金句，全部像真实群聊。 */
function sampleReport(mood) {
  return {
    title: '从一只猫聊到周末的山道',
    lead: '今天群里从一只占键盘的猫开始，聊了加班、夜宵和周末去哪儿。',
    topics: [
      {
        title: '猫一屁股坐在键盘上',
        summary: '阿离的文档写到一半被猫截胡，糖豆把猫和周末并列成今日最大愿望。',
        quotes: [
          { name: '阿离', text: '它一屁股坐下去，我半篇文档没了' },
          { name: '糖豆', text: '猫和周末我都要' },
        ],
      },
      {
        title: '不是在加班，就是在去加班的路上',
        summary: '老白一句自嘲把全群炸出来，大家开始接龙公司附近还开着的夜宵店。',
        quotes: [
          { name: '老白', text: '我不是在加班，就是在去加班的路上' },
        ],
      },
      {
        title: '周末六点半的山道',
        summary: '江雾把周末爬山安排得明明白白：地铁口集合，迟到的请全群喝奶茶。',
        quotes: [
          { name: '江雾', text: '周六六点半地铁口集合，迟到的人请喝奶茶' },
        ],
      },
    ],
    quotes: [
      { name: '阿离', text: '它一屁股坐下去，我半篇文档没了', why: '每个养猫人都懂的痛' },
      { name: '老白', text: '我不是在加班，就是在去加班的路上', why: '自嘲得很准' },
      { name: '江雾', text: '周六六点半地铁口集合，迟到的人请喝奶茶', why: '组织力惊人' },
    ],
    // 只有模板声明了插画槽时预览才有氛围；非插画模板不带 visual。
    ...(typeof mood === 'string' && mood !== '' ? { visual: { mood } } : {}),
  };
}

/**
 * 构造示例日报 payload。
 * @param {{day?: string, mood?: string}} [options] mood 由模板声明决定，非插画模板留空
 * @returns {object} 与 daily.js 生成的真实 payload 同形状（version 1）
 */
export function sampleDailyPayload({ day, mood = '' } = {}) {
  const bounds = dayBounds(day);
  const target = bounds.day;
  const selectedMood = typeof mood === 'string' ? mood.trim() : '';
  const base = new Date(bounds.start);
  const first = new Date(base);
  first.setHours(8, 12, 0, 0);
  const last = new Date(base);
  last.setHours(23, 41, 0, 0);
  return {
    version: 1,
    botId: 'sample-bot',
    peer: 'group:sample',
    day: target,
    generatedAt: Date.now(),
    meta: { sampleSize: 300, transcriptChars: 1280, digest: 'SAMPLE01' },
    stats: {
      total: SAMPLE_TOTAL,
      speakers: SAMPLE_SPEAKERS,
      topSpeakers: TOP_SPEAKERS.map((item) => ({ ...item })),
      hours: HOURS.slice(),
      firstAt: first.getTime(),
      lastAt: last.getTime(),
    },
    report: sampleReport(selectedMood),
  };
}

export default sampleDailyPayload;
