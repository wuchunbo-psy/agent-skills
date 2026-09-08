// scripts/lib/html_links.mjs
// 正文链接提取：HTML 实体解码、href 提取、URL 规范化、来源分类。

import { normalizeUrl } from './manifest.mjs';

const LARGE_ATTACHMENT_HOSTS = [
  'wx.mail.qq.com/ftn',
  'mail.126.com',
  '126.com',
  'mail.163.com/large',
  '163.com/large',
  'dashi.163.com',       // 网易邮箱大师云附件
  'dashi.163.com/html/cloud-attachment-download',
];
const CLOUD_DISK_HOSTS = ['pan.baidu.com', 'aliyundrive', 'alipan.com', 'cloud.189.cn', 'pan.quark.cn', 'drive.google.com', 'docs.google.com'];
const PORTFOLIO_HOSTS = ['artstation.com', 'behance.net', 'zcool.com.cn', 'dribbble.com', 'lanhuapp.com'];
const PORTFOLIO_TEXT_RE = /作品集|作品|portfolio|个人站|主页|homepage|behance|artstation/i;

/**
 * 从 HTML 中提取所有链接，返回 [{ url, text, kind }]。
 * kind: 'large_attachment' | 'cloud_disk' | 'portfolio' | 'unknown'
 *
 * @param {string} html - body_html 原文
 * @returns {Array<{url:string, text:string, kind:string}>}
 */
// QQ 大附件卡片的两种文件名形态：
// ①邮件 HTML：<div title="手绘低模.jpg&#10;&#10;文件大小：5.8MB&#10;&#10;到期时间：…" class="bigatt_bt">
// ②IM 邮箱助手卡片：「手绘低模.jpg (5.8MB, 2026年9月19日 17:26)」
// 用于给链接类 record 补 original_filename——2026-08-20 事故：一封邮件两个大附件，
// 汇总只显示邮件主题「手绘低模.jpg ×2」，实为手绘低模+苏树林作品两个不同附件，
// 被误判重复整封排除（误伤苏树林）。链接旁的文件名是区分多附件的唯一线索。
const ATTACH_NAME_RES = [
  /title="([\w\-—－()（）\[\]【】.,，\u4e00-\u9fa5]+\.(?:pdf|zip|rar|7z|docx?|pptx?|jpg|jpeg|png))[\s\S]{0,30}?文件大小[\s\S]{0,5}?([\d.]+)\s*([MG])B/,
  /([\w\-—－()（）\[\]【】.,，\u4e00-\u9fa5]+\.(?:pdf|zip|rar|7z|docx?|pptx?|jpg|jpeg|png))\s*[（(]\s*(\d+(?:\.\d+)?)\s*([MG])B/i,
];

/**
 * 在 html 中 position 前后窗口内找附件名+大小（title 属性「文件名&#10;文件大小：5.8MB」/
 * 文本形态「文件名 (5.8MB, 日期)」）。大小用于下载前的 Downloads 本地复用校验。
 */
function findAttachName(decoded, position) {
  const win = decoded.slice(Math.max(0, position - 350), position + 150);
  for (const re of ATTACH_NAME_RES) {
    const m = win.match(re);
    if (m) {
      // 统一为 MB 数（KB 场景极少，直接按字面单位换算）
      const sizeMb = m[3].toUpperCase() === 'G' ? parseFloat(m[2]) * 1024 : parseFloat(m[2]);
      return { filename: m[1], size_mb: isFinite(sizeMb) ? sizeMb : null };
    }
  }
  return { filename: null, size_mb: null };
}

export function extractLinks(html) {
  if (!html) return [];
  // 先做全局实体 decode（href 属性值里 &amp; 很常见）
  const decoded = decodeHtmlEntities(html);
  const results = [];
  const seen = new Set();
  const push = (rawUrl, text, attach = null) => {
    if (!rawUrl || /^(mailto:|javascript:|#)/i.test(rawUrl)) return;
    try {
      const normalized = normalizeUrl(rawUrl);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      results.push({
        url: normalized, text, kind: classifyLink(normalized, text),
        filename: attach ? attach.filename : null,
        size_mb: attach ? attach.size_mb : null,
      });
    } catch {
      // URL 解析失败仍记录为 unknown，不静默丢
      const fallback = rawUrl.toLowerCase();
      if (!seen.has(fallback)) {
        seen.add(fallback);
        results.push({
          url: rawUrl, text, kind: classifyLink(rawUrl, text),
          filename: attach ? attach.filename : null,
          size_mb: attach ? attach.size_mb : null,
        });
      }
    }
  };
  // 匹配 <a ... href="...">锚文本</a>
  const anchorRe = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(decoded)) !== null) {
    push(m[1], stripTags(m[2] || '').trim(), findAttachName(decoded, m.index));
  }
  // 补捞无闭合标签的 <a href="...">（QQ 邮箱 HTML 常见，配 </p> 直接断）
  // 已被上面闭合匹配吃掉的不会重复（seen 去重）
  const openAnchorRe = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
  while ((m = openAnchorRe.exec(decoded)) !== null) {
    push(m[1], '', findAttachName(decoded, m.index));
  }
  // 纯文本裸 URL 兜底：链接不在 <a> 标签里、直接写在正文中（中文标点作边界，防吞句号）
  const bareUrlRe = /https?:\/\/[^\s<>"')\]。，；、！？]+/gi;
  while ((m = bareUrlRe.exec(decoded)) !== null) {
    push(m[0], '', findAttachName(decoded, m.index));
  }
  return results;
}

/**
 * 分类单个链接。先按域名，再按锚文本。
 */
export function classifyLink(url, text = '') {
  const lower = (url || '').toLowerCase();
  const combined = `${lower} ${text}`;
  if (LARGE_ATTACHMENT_HOSTS.some(h => lower.includes(h))) return 'large_attachment';
  if (CLOUD_DISK_HOSTS.some(h => lower.includes(h))) return 'cloud_disk';
  if (PORTFOLIO_HOSTS.some(h => lower.includes(h))) return 'portfolio';
  if (PORTFOLIO_TEXT_RE.test(combined)) return 'portfolio';
  return 'unknown';
}

/**
 * 是否为"作品/附件材料类"链接（需要人工或浏览器下载）。
 */
export function isMaterialLink(link) {
  return link.kind !== 'unknown' || /作品|附件|简历|portfolio|artstation|resume/i.test(`${link.url} ${link.text}`);
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '');
}
