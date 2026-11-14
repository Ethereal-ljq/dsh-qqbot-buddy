/**
 * components/TemplateInstallDrawer —— 新增群日报卡片模板。
 *
 * 两条录入路径（二选一，优先目录）：
 *  1) 选择本地模板目录（webkitdirectory）：保留相对路径，二进制统一转 base64，
 *     目录内的 meta.json 会解析并预填显示名 / 描述；
 *  2) 粘贴单文件 HTML：直接作为 index.html 安装。
 *
 * 客户端按后端契约先做一次校验（模板名规则、index.html、扩展名白名单、8MB 上限），
 * 405/409 等错误落到抽屉内的行内提示，不打断用户输入。
 */
import { useEffect, useRef, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { ReportTemplateFile, ReportTemplateInstallResult } from '../api/types';
import { fmtBytes } from '../lib/format';
import { Drawer } from './Drawer';
import { Field } from './Field';

/** 模板名规则：与后端 template-registry.js 的 TEMPLATE_NAME_RE 一致。 */
const TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** 允许的扩展名（与后端 install 路由白名单一致；路径另限 index.html / meta.json / assets/**）。 */
const ALLOWED_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'json', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'woff', 'woff2', 'ttf', 'otf',
]);
const MAX_FILES = 64;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

interface PickedFile extends ReportTemplateFile {
  /** 原始字节数（展示与总量校验用；content 是 base64）。 */
  bytes: number;
}

/** Uint8Array → base64（分块拼接，大文件不会爆调用栈）。 */
function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunkSize)));
  }
  return btoa(binary);
}

function textToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/** 相对路径安全校验：不能绝对、不能有 .. / . / 空段、不能有反斜杠。 */
function safeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** 允许路径：根目录只认 index.html / meta.json，其余必须在 assets/ 下且扩展名在白名单。 */
function allowedPath(value: string): boolean {
  if (!safeRelativePath(value)) return false;
  if (value === 'index.html' || value === 'meta.json') return true;
  if (!value.startsWith('assets/')) return false;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  return ALLOWED_EXTENSIONS.has(value.slice(dot + 1).toLowerCase());
}

function isMetaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function TemplateInstallDrawer({ open, onClose, onInstalled }: {
  open: boolean;
  onClose: () => void;
  /** 安装成功：父组件负责 notify / 刷新列表 / 选中新模板。 */
  onInstalled: (result: ReportTemplateInstallResult) => void;
}) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [pastedHtml, setPastedHtml] = useState('');
  const [replace, setReplace] = useState(false);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [dirRoot, setDirRoot] = useState('');
  const [skipped, setSkipped] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const folderPicked = files.length > 0;

  // 每次打开都从空表单开始；同时给目录选择器补上 webkitdirectory（React 无此 prop 类型）。
  useEffect(() => {
    if (!open) return;
    setName('');
    setLabel('');
    setDescription('');
    setPastedHtml('');
    setReplace(false);
    setFiles([]);
    setDirRoot('');
    setSkipped([]);
    setReading(false);
    setBusy(false);
    setError(null);
    const input = dirInputRef.current;
    if (input) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
  }, [open]);

  const readDirectory = async (list: File[] | null) => {
    if (!list || list.length === 0) return;
    setReading(true);
    setError(null);
    const picked: PickedFile[] = [];
    const ignored: string[] = [];
    const seen = new Set<string>();
    let root = '';
    let total = 0;
    let totalTooLarge = false;
    let metaText = '';
    try {
      for (const file of list) {
        const rawPath = (file.webkitRelativePath || file.name).replace(/^\.\//, '');
        const segments = rawPath.split('/');
        if (root === '' && segments.length > 1) root = segments[0];
        const relative = segments.length > 1 ? segments.slice(1).join('/') : segments[0];
        if (!allowedPath(relative)) {
          ignored.push(relative);
          continue;
        }
        if (seen.has(relative)) continue;
        seen.add(relative);
        total += file.size;
        if (total > MAX_TOTAL_BYTES) {
          totalTooLarge = true;
          break;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        picked.push({ path: relative, content: toBase64(bytes), bytes: bytes.byteLength });
        if (relative === 'meta.json') {
          try { metaText = await file.text(); } catch { metaText = ''; }
        }
      }
    } catch (err) {
      setReading(false);
      setError('读取模板文件失败：' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    setReading(false);
    setSkipped(ignored);
    setDirRoot(root);
    if (totalTooLarge) {
      setFiles([]);
      setError('模板文件总大小超过 8MB 上限，请精简 assets/ 里的图片或字体。');
      return;
    }
    if (picked.length > MAX_FILES) {
      setFiles([]);
      setError('模板文件超过 ' + MAX_FILES + ' 个（后端上限），请精简目录。');
      return;
    }
    if (picked.length === 0) {
      setFiles([]);
      setError('所选目录里没有可安装的文件：需要 index.html，资源放 assets/（html/css/js/json/webp/png/jpg/gif/svg/字体）。');
      return;
    }
    setFiles(picked);
    if (!picked.some((file) => file.path === 'index.html')) {
      setError('模板目录缺少 index.html：卡片模板必须在根目录有 index.html。');
      return;
    }
    // 目录名合法且用户还没填模板名时，顺手预填（省一次手输）。
    if (root !== '' && TEMPLATE_NAME_RE.test(root)) {
      setName((prev) => (prev.trim() === '' ? root : prev));
    }
    // meta.json 的 label/description 预填（用户已手动填写的不覆盖）。
    if (metaText !== '') {
      try {
        const meta: unknown = JSON.parse(metaText);
        if (isMetaRecord(meta)) {
          const metaLabel = typeof meta.label === 'string' ? meta.label : '';
          const metaDescription = typeof meta.description === 'string' ? meta.description : '';
          if (metaLabel !== '') setLabel((prev) => (prev.trim() === '' ? metaLabel : prev));
          if (metaDescription !== '') setDescription((prev) => (prev.trim() === '' ? metaDescription : prev));
        }
      } catch {
        /* meta.json 不合法：原样上传，由后端读回兜底（不阻塞安装） */
      }
    }
    setError(null);
  };

  const clearDirectory = () => {
    setFiles([]);
    setDirRoot('');
    setSkipped([]);
    setError(null);
    if (dirInputRef.current) dirInputRef.current.value = '';
  };

  /** 提交用的 files：优先目录内容；否则把粘贴的 HTML 当作 index.html。 */
  const buildFiles = (): ReportTemplateFile[] => {
    if (files.length > 0) return files.map((file) => ({ path: file.path, content: file.content }));
    if (pastedHtml.trim() === '') return [];
    return [{ path: 'index.html', content: textToBase64(pastedHtml) }];
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!TEMPLATE_NAME_RE.test(trimmedName)) {
      setError('模板名不合法：需以字母或数字开头，只含字母、数字、下划线、短横线，最长 32 个字符（内置名 journal/dark/off 保留）。');
      return;
    }
    const uploadFiles = buildFiles();
    if (uploadFiles.length === 0) {
      setError(folderPicked ? '模板目录仍在读取，请稍候再试。' : '请选择模板目录，或粘贴单文件 HTML。');
      return;
    }
    if (!uploadFiles.some((file) => file.path === 'index.html')) {
      setError('缺少 index.html：目录模板的根目录必须有 index.html。');
      return;
    }
    const bytes = folderPicked ? totalBytes : new TextEncoder().encode(pastedHtml).byteLength;
    if (bytes > MAX_TOTAL_BYTES) {
      setError('模板总大小 ' + fmtBytes(bytes) + ' 超过 8MB 上限。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.installReportTemplate({
        name: trimmedName,
        label: label.trim() || undefined,
        description: description.trim() || undefined,
        files: uploadFiles,
        replace,
      });
      onInstalled(result);
    } catch (err) {
      const apiError = toApiError(err);
      if (apiError.code === 'template_exists') {
        setError('同名模板已存在，勾选「覆盖同名模板」后重试。');
      } else if (apiError.unimplemented) {
        setError('后端未装配模板安装接口（HTTP ' + apiError.status + '）：确认控制台版本已加载日报模板路由，并配置了数据目录。');
      } else {
        setError(apiError.message || '安装失败，请检查模板文件后重试。');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      title="新增卡片模板"
      subtitle={'安装到 <dataDir>/templates/<名字>/index.html'}
      width={560}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || reading}>
            {busy ? '安装中…' : '安装模板'}
          </button>
        </>
      )}
    >
      <div className="form-stack">
        {error ? (
          <div className="note note-error compact" role="alert">
            <span className="note-title">{error}</span>
          </div>
        ) : null}

        <Field
          label="模板名"
          htmlFor="tpl-install-name"
          required
          help="目录名，也是配置项 daily.template 的值；规则 [A-Za-z0-9][A-Za-z0-9_-]{0,31}。"
        >
          <input
            id="tpl-install-name"
            className="input mono"
            value={name}
            maxLength={32}
            placeholder="my-card"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="显示名" htmlFor="tpl-install-label" help="模板列表里展示的名字；留空则用模板名。">
          <input
            id="tpl-install-label"
            className="input"
            value={label}
            maxLength={80}
            placeholder="我的卡片"
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field label="描述" htmlFor="tpl-install-desc" wide help="一句话说明适用场景，会显示在模板详情里。">
          <textarea
            id="tpl-install-desc"
            className="textarea"
            rows={2}
            maxLength={300}
            value={description}
            placeholder="例如：适合深夜聊天的低饱和数据卡"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <div className="tpl-divider"><span>模板文件</span></div>

        <Field
          label="模板目录"
          help="选择包含 index.html 的目录（可带 meta.json 与 assets/ 资源）；只保留目录内相对路径，二进制文件自动转 base64。"
        >
          <div className="tpl-file-picker">
            <input
              ref={dirInputRef}
              type="file"
              multiple
              className="tpl-file-input"
              onChange={(event) => {
                // 先把 FileList 拷成数组再清空 input.value：FileList 是活引用，
                // 清空 value 后原对象会变空，导致「选了目录却读不到文件」。
                const list = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                event.currentTarget.value = '';
                void readDirectory(list);
              }}
            />
            <button type="button" className="btn btn-sm" onClick={() => dirInputRef.current?.click()} disabled={reading}>
              {reading ? '读取中…' : '选择模板目录…'}
            </button>
            {folderPicked ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearDirectory} disabled={reading}>清除</button>
            ) : null}
            <span className="tpl-file-summary mono">
              {reading
                ? '正在读取文件…'
                : folderPicked
                  ? (dirRoot || '(目录)') + ' · ' + files.length + ' 个文件 · ' + fmtBytes(totalBytes)
                  : '未选择目录'}
            </span>
          </div>
        </Field>

        {skipped.length > 0 ? (
          <p className="tpl-file-note">
            已忽略 {skipped.length} 个非白名单文件：<span className="mono">{skipped.slice(0, 4).join('、')}{skipped.length > 4 ? '…' : ''}</span>
          </p>
        ) : null}

        {folderPicked ? (
          <ul className="tpl-file-list">
            {files.slice(0, 12).map((file) => (
              <li className="tpl-file-item" key={file.path}>
                <span className="mono tpl-file-path">{file.path}</span>
                <span className="muted mono">{fmtBytes(file.bytes)}</span>
              </li>
            ))}
            {files.length > 12 ? <li className="tpl-file-item muted">… 另有 {files.length - 12} 个文件</li> : null}
          </ul>
        ) : null}

        <div className="tpl-divider"><span>或粘贴单文件 HTML</span></div>

        <Field
          label="单文件 HTML"
          htmlFor="tpl-install-html"
          help="自包含模板（样式与图片内联），会保存为 index.html；已选择目录时以目录为准。"
        >
          <textarea
            id="tpl-install-html"
            className="textarea mono tpl-html-area"
            rows={8}
            spellCheck={false}
            value={pastedHtml}
            placeholder={'<!doctype html>\n<html>…</html>'}
            onChange={(event) => setPastedHtml(event.target.value)}
          />
        </Field>

        <p className="tpl-file-note">
          允许的文件：index.html、meta.json、assets/**（html/css/js/json/webp/png/jpg/jpeg/gif/svg/woff/woff2/ttf/otf）；最多 64 个文件、总大小 8MB。
        </p>

        <label className="check tpl-replace">
          <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
          <span className="check-box" aria-hidden="true" />
          <span className="tpl-replace-text">覆盖同名模板（先删除 <span className="mono">templates/&lt;名字&gt;</span> 下的旧目录再写入）</span>
        </label>
      </div>
    </Drawer>
  );
}
