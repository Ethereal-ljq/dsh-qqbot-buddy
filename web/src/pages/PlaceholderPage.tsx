/**
 * pages/PlaceholderPage —— 后续里程碑页面的占位：说清“为什么还没接、接口在哪、交付什么”。
 * 不用假数据填充，避免把未完成能力伪装成可用。
 */
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';

export interface PlaceholderSpec {
  title: string;
  description: string;
  milestone: string;
  endpoints: string[];
  features: string[];
  note?: string;
}

export function PlaceholderPage({ spec }: { spec: PlaceholderSpec }) {
  return (
    <div className="page">
      <PageHeader
        title={spec.title}
        description={spec.description}
        meta={<span className="pending-pill">计划 {spec.milestone}</span>}
      />

      <section className="panel pending-panel">
        <div className="pending-hero">
          <div className="pending-milestone mono" aria-hidden="true">{spec.milestone}</div>
          <div className="pending-copy">
            <h2 className="pending-title">该页面尚未接入数据</h2>
            <p className="pending-desc">
              控制台导航与路由已就位；接口返回 501 时前端保持空态，不会把未实现能力当作可用功能。
            </p>
            <div className="pending-endpoints">
              {spec.endpoints.map((endpoint) => <code key={endpoint} className="endpoint">{endpoint}</code>)}
            </div>
          </div>
        </div>

        <div className="pending-body">
          <h3 className="subsection-title">交付内容</h3>
          <ul className="pending-list">
            {spec.features.map((feature) => (
              <li key={feature}><span className="pending-tick" aria-hidden="true" />{feature}</li>
            ))}
          </ul>
          {spec.note ? <p className="pending-note">{spec.note}</p> : null}
        </div>
      </section>

      <EmptyState
        compact
        tone="pending"
        title={'等 ' + spec.milestone + ' 数据源接入后开放'}
        description="在此之前，机器人、配置档、工具与知识库页已可用。"
      />
    </div>
  );
}

export const PLACEHOLDER_SPECS: Record<string, PlaceholderSpec> = {
  '/memory': {
    title: '记忆',
    description: 'bot 级共享的长期记忆：采集、检索、召回预算与来源回溯。',
    milestone: 'M4',
    endpoints: ['GET /api/memories?bot=', 'POST /api/memories', 'DELETE /api/memories/:id', 'POST /api/memories/search'],
    features: [
      '一个机器人一份记忆：切换配置档不丢记忆、不串记忆',
      'FTS5 trigram 检索，查询不足 3 字回退 LIKE 并标记 mode',
      '记忆来源按 peer 回溯，支持人工修订与删除',
      '按 Profile 的 memory.recallChars / recallTopK 预算注入 prompt',
    ],
    note: '记忆内核位于 lib/core/memory/store.js，控制台只负责查看与维护。',
  },
  '/members': {
    title: '群友库',
    description: '按 bot 共享的群友档案：openid、昵称、人工备注与画像 JSON。',
    milestone: 'M4',
    endpoints: ['GET /api/members?bot=', 'PATCH /api/members/:id', 'DELETE /api/members/:id'],
    features: [
      'openid 去重，按 bot 隔离',
      '自动从对话提炼昵称/画像，人工备注优先',
      '画像 JSON 直接进入 prompt 变量',
      '支持导出与清理（隐私相关操作走审计）',
    ],
  },
  '/personas': {
    title: '人格卡',
    description: '可切换的人设卡：每张卡是一段人设文本，Profile 通过 persona.activeCardId 引用。',
    milestone: 'M2–M4',
    endpoints: ['GET /api/personas?bot=', 'POST /api/personas', 'PATCH /api/personas/:id', 'DELETE /api/personas/:id'],
    features: [
      '人设卡独立于配置档，可被多份配置档复用',
      '生效卡由 Profile 设置项 persona.activeCardId 决定',
      '留空回退 bot 工作目录下的 persona.md',
      '与提示段覆盖（persona.guides）联动预览',
    ],
  },
  '/stickers': {
    title: '表情包',
    description: '表情包库：图片、emotion 标签、hash 去重与发送配额。',
    milestone: 'M3–M4',
    endpoints: ['GET /api/stickers?bot=', 'POST /api/stickers', 'DELETE /api/stickers/:id'],
    features: [
      '按 bot 共享，媒体文件落在 bot 的 media/ 目录',
      'hash 去重，emotion 标签供模型挑选',
      '每日配额与发送频率由 Profile 设置控制',
      '入站表情自动收藏（可配置开关）',
    ],
  },
};
