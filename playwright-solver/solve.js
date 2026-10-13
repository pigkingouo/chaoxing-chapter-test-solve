/**
 * solve.js — 超星学习通章节测试自动作答（Playwright + 多模态 LLM）
 *
 * 流程（对 config.chapterKids 里的每个章节测试）：
 *   1. 打开 studentstudy?chapterId={kid} → 递归找 iframe 里的 doHomeWorkNew 完整 URL
 *   2. 新开独立页打开答题页 → 逐题截图 → 调多模态 LLM 判断答案
 *   3. 按答案点击选项（单选/多选）/ 填 UEditor 填空 → 校验 → 提交
 *   4. 读成绩；若 < minScore 且有"重做"入口 → 从结果页（清晰文本）解析正确答案 → 重做
 *
 * ⚠️ 免责声明：仅供学习交流，请遵守学校学术规范，后果自负。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const fd = require('./font-decode');

// Node >= 18 守卫（fetch / 全局 API 依赖）
const [maj] = process.versions.node.split('.').map(Number);
if (maj < 18) {
  console.error(`❌ 需要 Node 18+，当前 ${process.versions.node}。请升级后重试。`);
  process.exit(1);
}

let config;
try {
  // 去 BOM：Windows 记事本等编辑器写 UTF-8 BOM 会导致 JSON.parse 失败
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  config = JSON.parse(raw);
} catch (e) {
  console.error('❌ 读取 config.json 失败（' + e.message.slice(0, 120) + '）。请复制 config.example.json 为 config.json 并填写。');
  process.exit(1);
}
// 环境变量优先于 config.json（便于代理工具/CI 注入密钥，避免密钥落盘）
config.llm = config.llm || {};
config.llm.baseUrl = (process.env.LLM_BASE_URL || config.llm.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
config.llm.apiKey = (process.env.LLM_API_KEY || config.llm.apiKey || '').trim();
config.llm.model = (process.env.LLM_MODEL || config.llm.model || '').trim();
config.llm.timeoutMs = config.llm.timeoutMs || 120000;
config.llm.maxRetries = config.llm.maxRetries ?? 3;
config.llm.minIntervalMs = config.llm.minIntervalMs ?? 500; // 借鉴：LLM 请求最小间隔限速
config.answerCache = config.answerCache !== false; // 默认开启答案缓存
// 读题模式：auto=本地解码文本优先、解码不佳回退截图；text=始终文本；vision=始终截图（旧行为）
config.readMode = ['auto', 'text', 'vision'].includes(config.readMode) ? config.readMode : 'auto';
// 无答案时随机作答兜底（保证章节能提交、可解锁；默认关，宁缺毋滥）
config.guessOnFail = config.guessOnFail === true;
// 章节检测自动重做（借鉴 work_redo_enabled / work_max_retries：仅允许作答一次的课程建议关掉）
config.workRedoEnabled = config.workRedoEnabled !== false;
config.workMaxRetries = Number.isInteger(config.workMaxRetries) && config.workMaxRetries > 0 ? config.workMaxRetries : 3;
if (!config.llm.apiKey) {
  console.error('❌ 缺少 LLM API Key：请在 config.json 的 llm.apiKey 或环境变量 LLM_API_KEY 中提供');
  process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 字体指纹表（本地解码反爬字体用；缺失时自动回退截图视觉模式） ----------
// 表文件来源见 README「字体本地解码」一节；指纹表缺失/损坏不影响主流程。
let glyphTable = null;
try {
  const tablePath = config.fontTable ? path.resolve(__dirname, config.fontTable) : fd.DEFAULT_TABLE_PATH;
  if (fs.existsSync(tablePath)) {
    glyphTable = fd.loadGlyphTable(tablePath);
    console.log(`✅ 字体指纹表已加载（${glyphTable.size} 条）：读题优先本地解码`);
  } else {
    console.log('ℹ️ 未找到字体指纹表（resource/font_map_table.json），读题回退截图视觉模式');
  }
} catch (e) {
  console.log('⚠️ 字体指纹表加载失败（' + String(e.message).slice(0, 80) + '），读题回退截图视觉模式');
}

// ---------- 答案缓存（借鉴 Samueli924/chaoxing 的 CacheDAO 设计：原子写 + 损坏恢复 + 重做跳过） ----------
// 键为 kid+题号。注意：教师改题会使缓存失效，重做模式（knownAnswers 存在）会跳过读缓存。
const CACHE_FILE = path.join(__dirname, 'answer-cache.json');
let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof _cache !== 'object' || !_cache) _cache = {};
  } catch (e) {
    if (fs.existsSync(CACHE_FILE)) {
      try { fs.copyFileSync(CACHE_FILE, CACHE_FILE + '.bak.' + Date.now()); } catch (e2) { /* 备份失败不阻断 */ }
      console.log('  ⚠️ 答案缓存损坏，已备份并用空缓存继续');
    }
    _cache = {};
  }
  return _cache;
}
function cacheGet(key) { return loadCache()[key]; }
function cacheSet(key, answer) {
  try {
    loadCache()[key] = { answer, ts: Date.now() };
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE); // 原子替换，避免写一半损坏
  } catch (e) { console.log('  ⚠️ 缓存写入失败: ' + e.message); }
}

// ---------- 答案类型校验（借鉴 Samueli924/chaoxing 的 check_answer：类型不符直接舍弃） ----------
function validateAnswer(ans, meta) {
  if (meta.type === 'blank') {
    const arr = Array.isArray(ans) ? ans : [ans];
    return arr.length === meta.blanks && arr.every(v => String(v ?? '').trim().length > 0);
  }
  const letters = String(ans ?? '').toUpperCase().replace(/[^A-H]/g, ''); // A-H：兼容 5-8 个选项的题
  if (meta.type === 'single') return letters.length === 1;
  if (meta.type === 'multi') {
    const uniq = [...new Set(letters.split(''))];
    return uniq.length >= 1 && uniq.length === letters.length; // ≥1 项且无重复（多选题正确答案也可能只有一项）
  }
  return false;
}

// ---------------- LLM ----------------
// 兼容性设计：仅用 OpenAI 兼容 /chat/completions + 非流式 + 不依赖 function-calling，
// 以覆盖最大范围的 provider（DeepSeek/Qwen/GLM/Moonshot/SiliconFlow/OpenAI/兼容网关）。
let _lastLlmAt = 0; // 借鉴：请求间最小间隔限速，降低触发 provider 限流的概率
async function askLLM(images, prompt) {
  const gap = config.llm.minIntervalMs - (Date.now() - _lastLlmAt);
  if (gap > 0) await sleep(gap);
  const body = JSON.stringify({
    model: config.llm.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))
      ]
    }],
    temperature: 0,
    stream: false // 显式非流式：部分网关默认流式，非流式响应解析失败
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= config.llm.maxRetries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llm.timeoutMs);
    try {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
        body,
        signal: ac.signal
      });
      _lastLlmAt = Date.now();
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseFloat(res.headers.get('retry-after')) * 1000 || Math.min(60000, 2000 * 2 ** (attempt - 1));
        lastErr = new Error(`LLM HTTP ${res.status}（${attempt}/${config.llm.maxRetries} 次）`);
        if (attempt < config.llm.maxRetries) { console.log(`  ⏳ ${lastErr.message}，${Math.round(retryAfter / 1000)}s 后重试`); await sleep(retryAfter); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`LLM HTTP ${res.status}：${detail}`); // 4xx 参数/鉴权错误：不重试直接抛
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM 响应缺少 choices[0].message.content：' + JSON.stringify(data).slice(0, 300));
      return content;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isAbort = e.name === 'AbortError';
      const retryable = isAbort || /HTTP (429|5\d\d)/.test(e.message) || /fetch|network|ECONN/i.test(e.message);
      if (retryable && attempt < config.llm.maxRetries) {
        const backoff = Math.min(60000, 2000 * 2 ** (attempt - 1));
        console.log(`  ⏳ LLM 调用失败（${isAbort ? `超时 ${config.llm.timeoutMs}ms` : e.message.slice(0, 120)}），${Math.round(backoff / 1000)}s 后重试`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`LLM 调用失败: ${e.message}`);
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

function parseJSON(text) {
  // 加固：剥掉 ```json 代码围栏；取最后一个平衡的 {...}（模型常先输出解释文字）
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const candidates = cleaned.match(/\{[^{}]*\}/g) || [];
  const nested = cleaned.match(/\{[\s\S]*\}/g) || [];
  for (const c of [...candidates, ...nested].reverse()) {
    try { return JSON.parse(c); } catch (e) { /* 试下一个 */ }
  }
  throw new Error(`LLM 未返回可解析 JSON（模型 ${config.llm.model}）：` + String(text).replace(/\s+/g, ' ').slice(0, 200));
}

// ---------------- 页面内执行的辅助（注入答题页 frame） ----------------
function injectHelpers() {
  const LETTERS = 'ABCDEFGH'; // 兼容 5-8 个选项的题
  const isChoiceLi = li => /addChoice|addMultipleChoice/.test(li.getAttribute('onclick') || '');
  window.__cx = {
    timus() {
      return [...document.querySelectorAll('.TiMu')].map((tm, i) => {
        const lis = [...tm.querySelectorAll('li')].filter(isChoiceLi);
        const multi = lis.length > 0 && /addMultipleChoice/.test(lis[0].getAttribute('onclick'));
        const blanks = [...tm.querySelectorAll('textarea')].filter(t => /^answerEditor/.test(t.id)).length;
        return { no: i + 1, type: blanks ? 'blank' : (multi ? 'multi' : 'single'),
                 options: lis.length, blanks, top: tm.getBoundingClientRect().top + scrollY };
      });
    },
    checked(no) {
      const tm = document.querySelectorAll('.TiMu')[no - 1];
      const lis = [...tm.querySelectorAll('li')].filter(isChoiceLi);
      return lis.map((li, n) => { const sp = li.querySelector('span');
        return sp && /check_answer/.test(sp.className) ? LETTERS[n] : null; }).filter(x => x).join('');
    },
    click(no, letters) {
      const tm = document.querySelectorAll('.TiMu')[no - 1];
      const lis = [...tm.querySelectorAll('li')].filter(isChoiceLi);
      if (/addMultipleChoice/.test((lis[0] || {}).getAttribute?.('onclick') || '')) {
        lis.forEach(li => { const sp = li.querySelector('span');
          if (sp && /check_answer/.test(sp.className)) li.click(); }); // 多选先清空
      }
      for (const ch of letters) { const idx = LETTERS.indexOf(ch); if (idx > -1 && lis[idx]) lis[idx].click(); }
      return this.checked(no);
    },
    fillBlanks(no, values) {
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // 必须转义：UEditor setContent 按富文本解析，SQL 答案中的 <、>、& 会被当作标签吞掉
      const tm = document.querySelectorAll('.TiMu')[no - 1];
      const insts = window.UE && window.UE.instants
        ? Object.values(window.UE.instants).filter(e => tm.contains(e.iframe))
        : [];
      insts.sort((a, b) => (a.iframe.compareDocumentPosition(b.iframe) & 4) ? -1 : 1);
      insts.forEach((ed, n) => { ed.setContent(esc(values[n] ?? '')); try { ed.sync(); } catch (e) {} });
      // 回读编辑器实际内容（剥标签），供 Node 侧与期望值比对
      return insts.map(ed => { try { return String(ed.getContent()).replace(/<[^>]*>/g, ''); } catch (e) { return ''; } });
    }
  };
}

// ---------------- 题目文本提取 + 字体本地解码 ----------------
// 在答题页内提取：加密字体 base64 + 逐题题干/选项文本（DOM 原文，可能被反爬字体混淆）
function grabQuestionText() {
  const style = document.querySelector('style#cxSecretStyle');
  let fontB64 = null;
  if (style) {
    const m = /base64,([\w\W]+?)['")]/.exec(style.textContent || '');
    if (m) fontB64 = m[1].replace(/\s+/g, '');
  }
  const cleanOpt = s => String(s).replace(/^[A-Za-z]\s*[.、:：)?）]?\s*/, '').trim(); // 去掉选项前导字母编号
  const timus = [...document.querySelectorAll('.TiMu')].map(tm => {
    const clone = tm.cloneNode(true);
    clone.querySelectorAll('li').forEach(li => {
      if (/addChoice|addMultipleChoice/.test(li.getAttribute('onclick') || '')) li.remove();
    });
    clone.querySelectorAll('script, style').forEach(n => n.remove());
    const stem = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    const options = [...tm.querySelectorAll('li')]
      .filter(li => /addChoice|addMultipleChoice/.test(li.getAttribute('onclick') || ''))
      .map(li => cleanOpt((li.textContent || '').replace(/\s+/g, ' ')));
    const hasImg = !!tm.querySelector('img');
    return { stem, options, hasImg };
  });
  return { fontB64, timus };
}

/**
 * 提取并解码整页题目文本。
 * @returns {{available: boolean, perQ: Array<{stem:string, options:string[], hasImg:boolean, missRate:number}>|null}}
 *          available=false 表示本地解码不可用（无表/无字体解析失败），调用方回退截图视觉模式。
 */
async function extractDecodedText(workFrame) {
  if (!glyphTable) return { available: false, perQ: null };
  let raw;
  try {
    raw = await workFrame.evaluate(grabQuestionText);
  } catch (e) {
    return { available: false, perQ: null };
  }
  let fontMap = null;
  if (raw.fontB64) {
    // 有加密字体：必须成功解析出字型指纹才可用
    try {
      fontMap = fd.buildFontMap(fd.decodeFontData(raw.fontB64));
    } catch (e) { fontMap = null; }
    if (!fontMap || fontMap.size === 0) return { available: false, perQ: null };
  }
  const perQ = raw.timus.map(q => {
    if (!fontMap) {
      // 页面未启用字体加密：DOM 文本本身即明文
      return { stem: q.stem, options: q.options, hasImg: q.hasImg, missRate: 0 };
    }
    let decoded = 0, missed = 0;
    const stemR = fd.decrypt(fontMap, glyphTable, q.stem);
    decoded += stemR.decoded; missed += stemR.missed;
    const options = q.options.map(o => {
      const r = fd.decrypt(fontMap, glyphTable, o);
      decoded += r.decoded; missed += r.missed;
      return r.text;
    });
    const total = decoded + missed;
    return { stem: stemR.text, options, hasImg: q.hasImg, missRate: total ? missed / total : 0 };
  });
  return { available: true, perQ };
}

// ---------------- 核心流程 ----------------
async function findWorkUrl(page) {
  // 递归遍历所有 frame（Playwright 的 frames() 已包含嵌套 frame）
  for (let round = 0; round < 10; round++) {
    const frames = page.frames();
    const work = frames.find(fr => /doHomeWorkNew/.test(fr.url()));
    if (work) return work;
    // 已完成作答的章节，内嵌的是"已批阅页"而非答题页——明确报告而不是干等超时
    if (frames.some(fr => /selectWorkQuestion/.test(fr.url()))) {
      throw new Error('本章测试已完成作答（内嵌为已批阅页）。若结果页带"重做"链接，请从课程页进入重做流程后再运行');
    }
    await sleep(1500);
  }
  throw new Error('未找到 doHomeWorkNew frame（页面加载超时、未登录或章节结构异常）');
}

// 定位含 .TiMu 的答题 frame：重做后可能在主 frame，也可能回到嵌套 iframe，双路径兜底
async function resolveWorkFrame(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const fr = page.frames().find(f => /doHomeWorkNew/.test(f.url()));
    if (fr) {
      try { await fr.waitForSelector('.TiMu', { timeout: 4000 }); return fr; } catch (e) { /* 继续等 */ }
    }
    await sleep(1000);
  }
  throw new Error('30s 内未定位到含题目的答题页（.TiMu）');
}

// 判断题选项词表（借鉴参考项目 true_list / false_list）
const JUDGE_TRUE = /^(正确|对|是|√|true|t|yes|y)$/i;
const JUDGE_FALSE = /^(错误|错|否|×|false|f|no|n|不正确)$/i;
function isJudgement(options) {
  return options.length === 2 && JUDGE_TRUE.test(String(options[0]).trim()) && JUDGE_FALSE.test(String(options[1]).trim());
}

function buildPromptText(meta, qd, knownAnswers) {
  // 文本模式：基于本地解码还原的明文出题（不再依赖视觉识别字形）
  const rest = knownAnswers && knownAnswers[meta.no]
    ? `\n（参考：本题上一轮的正确答案是选项 ${knownAnswers[meta.no]}。选项顺序可能与之前不同，请根据上面的选项内容确认对应的字母。）`
    : '';
  if (meta.type === 'blank') {
    return `这是超星学习通的一道填空题（题干经字体解码还原，可能有个别字符仍是生僻字残留，请结合上下文甄别；看清否定词）。` +
      `题中有 ${meta.blanks} 个空。给出每个空的标准教材表述。\n` +
      `题目：${qd.stem}\n` +
      `严格输出 JSON：{"blanks": ["答案1", "答案2"]}${rest}`;
  }
  const optLines = qd.options.map((t, i) => `${'ABCDEFGH'[i]}. ${t}`).join('\n');
  return `这是超星学习通的一道${meta.type === 'multi' ? '多选' : '单选'}题（题干与选项经字体解码还原，个别字符可能仍是生僻字残留，请结合上下文甄别；特别当心题干里的否定词，如"不正确/不属于/不在"）。` +
    (isJudgement(qd.options) ? '本题是判断题（"正确/错误"二选一）。' : '') +
    `\n题目：${qd.stem}\n选项：\n${optLines}\n选择正确答案。` +
    (meta.type === 'multi' ? '多选：没把握的选项不要选（错选得0分）。' : '') +
    `\n严格输出 JSON：{"answer": "C"} 或多选 {"answer": "ABD"}${rest}`;
}

function buildPromptVision(meta, knownAnswers) {
  // 视觉模式：截图读题（本地解码不可用时的回退路径）
  let prompt;
  if (meta.type === 'blank') {
    prompt = `这是超星学习通的一道填空题截图（页面有反爬字体，个别字形可能失真，注意甄别；看清否定词）。` +
      `题中有 ${meta.blanks} 个空。给出每个空的标准教材表述。\n` +
      `严格输出 JSON：{"blanks": ["答案1", "答案2"]}`;
  } else {
    prompt = `这是超星学习通的一道${meta.type === 'multi' ? '多选' : '单选'}题截图（页面有反爬字体，个别字形可能失真，注意甄别；` +
      `特别当心题干里的否定词，如"不正确/不属于/不在"）。选项按屏幕顺序以 A、B、C、D${meta.options > 4 ? '、E…' : ''} 圆点标注。` +
      `仔细审题后给出正确答案。${meta.type === 'multi' ? '多选：没把握的选项不要选（错选得0分）。' : ''}\n` +
      `严格输出 JSON：{"answer": "C"} 或多选 {"answer": "ABD"}`;
  }
  if (knownAnswers && knownAnswers[meta.no]) {
    prompt += `\n（参考：本题已知的正确答案是选项 ${knownAnswers[meta.no]}。` +
      `选项顺序可能与之前不同，请根据截图中的选项内容确认对应的字母。）`;
  }
  return prompt;
}

async function solveWork(page, workFrame, knownAnswers, cachePrefix) {
  await workFrame.waitForSelector('.TiMu', { timeout: 20000 });
  await workFrame.evaluate(injectHelpers);
  const metas = await workFrame.evaluate(() => window.__cx.timus());
  console.log(`  共 ${metas.length} 题：`, metas.map(m => `${m.no}.${m.type}`).join(' '));

  // 读题材料准备：auto/text 模式先尝试字体本地解码
  let textQ = null;
  if (config.readMode !== 'vision') {
    textQ = await extractDecodedText(workFrame);
    if (textQ.available) {
      const avg = textQ.perQ.length ? textQ.perQ.reduce((s, q) => s + q.missRate, 0) / textQ.perQ.length : 0;
      console.log(`  📖 本地字体解码可用（平均未解码率 ${(avg * 100).toFixed(1)}%）`);
    } else {
      console.log('  📖 本地解码不可用，回退截图视觉模式');
    }
  }

  const answers = {}; // no -> letters / blanks[]
  const guessed = new Set(); // guessOnFail 的随机答案不写缓存
  for (const meta of metas) {
    const qd = textQ && textQ.available ? textQ.perQ[meta.no - 1] : null;
    const useText = !!qd && (config.readMode === 'text' || qd.missRate <= 0.2);

    let prompt, images;
    if (useText) {
      prompt = buildPromptText(meta, qd, knownAnswers);
      images = [];
      if (qd.hasImg) {
        // 题干含图（图片/公式）：文本之外补一张截图
        images = [(await workFrame.locator('.TiMu').nth(meta.no - 1).screenshot()).toString('base64')];
        prompt += '\n（注意：本题题干包含图片，已附截图，请结合判断。）';
      }
    } else {
      prompt = buildPromptVision(meta, knownAnswers);
      images = [(await workFrame.locator('.TiMu').nth(meta.no - 1).screenshot()).toString('base64')];
    }

    const cacheKey = `${cachePrefix}:q${meta.no}`;
    // 重做模式（knownAnswers 存在）跳过缓存读——让 LLM 参考正确答案重新作答
    if (!knownAnswers && config.answerCache) {
      const hit = cacheGet(cacheKey);
      if (hit && validateAnswer(hit.answer, meta)) {
        answers[meta.no] = hit.answer;
        console.log(`  第${meta.no}题(${meta.type}) → ${hit.answer}（缓存命中）`);
        continue;
      }
    }

    let finalAns = null;
    for (let tryn = 0; tryn < 2 && !finalAns; tryn++) {
      let raw;
      try {
        raw = await askLLM([b64], prompt + (tryn ? '\n\n上一次回复无法使用。只输出一行 JSON，不要任何解释和代码围栏。' : ''));
      } catch (e) {
        if (tryn) throw e;
        console.log(`  ⚠️ 第${meta.no}题 LLM 调用失败（${e.message.slice(0, 80)}），重试一次`);
        continue;
      }
      let p;
      try { p = parseJSON(raw); } catch (e) { console.log(`  ⚠️ 第${meta.no}题解析失败，重试一次`); continue; }
      const cand = meta.type === 'blank' ? p.blanks : p.answer;
      if (!cand || (Array.isArray(cand) && !cand.length)) continue; // 空答案，重试
      if (!validateAnswer(cand, meta)) { console.log(`  ⚠️ 第${meta.no}题答案类型与题型不符，重试一次`); continue; }
      finalAns = cand;
    }
    if (!finalAns) {
      if (config.guessOnFail && meta.type !== 'blank') {
        // 借鉴随机作答兜底：保证章节能提交（填空乱填无意义，仍中止）
        const pool = 'ABCDEFGH'.slice(0, meta.options).split('');
        finalAns = meta.type === 'multi'
          ? pool.sort(() => Math.random() - 0.5).slice(0, Math.min(2, pool.length)).sort().join('')
          : pool[Math.floor(Math.random() * pool.length)];
        guessed.add(meta.no);
        console.log(`  ⚠️ 第${meta.no}题两次获取均无效 → guessOnFail 已开启，随机作答 ${finalAns}`);
      } else {
        throw new Error(`第${meta.no}题两次获取均无效（空/类型不符），中止本章以免误提交`);
      }
    }
    answers[meta.no] = finalAns;
    if (!knownAnswers && config.answerCache && !guessed.has(meta.no)) cacheSet(cacheKey, finalAns);
    console.log(`  第${meta.no}题(${meta.type}) → ${finalAns}`);
  }

  // 执行作答 + 校验
  const norm = s => String(s).toUpperCase().split('').sort().join(''); // 多选答案与存储顺序可能不同，排序后比较
  const dec = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const meta of metas) {
    const ans = answers[meta.no];
    if (meta.type === 'blank') {
      const readback = await workFrame.evaluate(([no, v]) => window.__cx.fillBlanks(no, v), [meta.no, ans]);
      const bad = (Array.isArray(ans) ? ans : []).filter((v, n) => readback[n] === undefined || dec(readback[n]).trim() !== String(v).trim());
      console.log(bad.length
        ? `  ⚠️ 第${meta.no}题填空回读不一致: ${bad.join(' | ')}（回读 ${readback.map(dec).join(' | ')}）`
        : `  第${meta.no}题填空回读一致: ${readback.map(dec).join(' | ')}`);
    } else {
      // 借鉴：多选答案必须按字母序点击/提交（乱序可能导致提交失败）
      const sorted = [...String(ans).toUpperCase()].sort().join('');
      const got = await workFrame.evaluate(([no, ls]) => window.__cx.click(no, ls), [meta.no, sorted]);
      if (norm(got) !== norm(String(ans))) console.log(`  ⚠️ 第${meta.no}题校验不一致: 期望${ans} 实际${got}`);
    }
    await sleep(300);
  }
  // 目检：整页截图供日志留存（长页面截图可达数 MB，按需开启）
  if (config.debugFullPageScreenshot) {
    await page.screenshot({ path: `logs/answers-${Date.now()}.png`, fullPage: true });
  }
  return answers;
}

async function submitWork(page, workFrame) {
  const clicked = await workFrame.evaluate(() => {
    const btn = [...document.querySelectorAll('button, a')].find(b => (b.textContent || '').trim() === '提交');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('未找到"提交"按钮（页面可能未加载完或已提交过）');
  // 轮询确认弹窗（慢网下可能超过 2.5s 才出现）；只点包含"确认提交"的弹窗中的"确定"，
  // 其他弹窗（如"有题目未作答"）一律中止并带回内容，防止误确认
  let confirmed = false;
  // 弹窗可能在答题 frame 内（重做后嵌套 iframe 场景），也可能在主文档；frame 随导航可能失联，双层兜底
  const findDialog = async () => {
    for (const scope of [workFrame, page]) {
      try {
        const res = await scope.evaluate(() => {
          const btns = [...document.querySelectorAll('button, a')]
            .filter(b => (b.textContent || '').trim() === '确定' && b.offsetParent !== null); // 仅可见按钮
          let blocked = null;
          for (const b of btns) {
            const dlg = b.closest('[class*="dialog"],[class*="modal"],[class*="mask"],[class*="layer"],[class*="pop"]')
              || b.parentElement?.parentElement || document.body;
            const txt = (dlg.textContent || '').replace(/\s+/g, ' ');
            // 只点包含"确认提交"的弹窗中的"确定"；遍历完所有可见弹窗再决定是否被阻止
            if (/确认提交/.test(txt)) { b.click(); return { ok: true }; }
            if (!blocked) blocked = txt.slice(0, 120);
          }
          return blocked ? { ok: false, txt: blocked } : null; // 可见的"确定"弹窗但内容不符：带回家给调用方
        });
        if (res) return res;
      } catch (e) { /* frame 随整页跳转失联属正常，继续试下一个 scope */ }
    }
    return null;
  };
  for (let i = 0; i < 7 && !confirmed; i++) {
    await sleep(1500);
    const res = await findDialog();
    if (res) {
      if (res.ok) { confirmed = true; break; }
      throw new Error('提交被弹窗阻止（未盲目确认）: ' + res.txt);
    }
  }
  if (!confirmed) console.log('  ⚠️ 未捕获"确认提交"弹窗（可能已直接提交）');
  await page.waitForURL(/selectWorkQuestion/, { timeout: 30000 }).catch(() => {});
  await sleep(4000);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const score = text.match(/最终成绩([\d.]+)分/)?.[1] ?? text.match(/本次成绩([\d.]+)分/)?.[1];
  if (!score) {
    // 诊断信息：代理/CI 环境看不到页面，必须把现场带回 stdout
    console.log(`  ⚠️ 未读到成绩。当前 URL: ${page.url().slice(0, 100)}`);
    console.log(`  ⚠️ 页面摘要: ${text.slice(0, 160)}`);
  }
  const hasRedo = text.includes('重做');
  return { score: score ? parseFloat(score) : null, hasRedo, text };
}

function parseCorrectAnswers(resultText) {
  // 结果页是清晰文本：N 【单选题】...我的答案： X ...分 正确答案： Y
  // 注意：仅能解析单选/多选的"正确答案"；填空题的参考答案文本无固定格式，重做时填空仍靠 LLM 重新判断
  const map = {};
  const re = /(\d+)\s*【(单选题|多选题)】[\s\S]*?正确答案：\s*([A-H、]+)/g;
  let m;
  while ((m = re.exec(resultText)) !== null) map[m[1]] = m[3].replace(/[、\s]/g, '');
  return map;
}

async function solveChapter(context, kid, label) {
  // ⚠️ 必须用带 storageState 的 context 开页：browser.newPage() 会另开无 cookie 的新 context，所有页面都会因未登录失败
  const url = config.studentstudyUrlTemplate.replace('{kid}', kid);
  const page = await context.newPage();
  console.log(`\n===== ${label} (kid=${kid}) =====`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const workFrame = await findWorkUrl(page);
  const workUrl = workFrame.url();
  console.log('  答题页:', workUrl.slice(0, 90) + '...');

  // 独立页打开，避免嵌套 iframe 的导航问题
  await page.goto(workUrl, { waitUntil: 'domcontentloaded' });
  // 最常见的打开失败原因：URL 令牌不完整或会话过期 → 页面直接显示"无效的用户"
  await page.waitForTimeout(1200);
  const gate = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 80) : ''));
  if (/无效的用户|请先登录/.test(gate)) {
    throw new Error('答题页打开被拒（"' + gate.trim().slice(0, 30) + '"）：答题 URL 令牌不完整或会话过期，请重新从课程页进入');
  }
  let frame = await resolveWorkFrame(page); // let：重做分支会重新解析 frame

  let known = null;
  // 借鉴 work_redo_enabled / work_max_retries：仅允许作答一次的课程建议关掉自动重做
  const maxAttempts = config.workRedoEnabled ? config.workMaxRetries + 1 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await frame.evaluate(injectHelpers);
    await solveWork(page, frame, known, `kid${kid}`);
    const { score, hasRedo, text } = await submitWork(page, frame);
    console.log(`  🎯 第${attempt}次成绩: ${score}`);
    if (score !== null && score >= config.minScore) break;
    if (!config.workRedoEnabled) { console.log('  workRedoEnabled=false，保留当前成绩'); break; }
    if (!hasRedo) { console.log('  无重做机会，保持当前成绩'); break; }
    known = parseCorrectAnswers(text);
    if (!Object.keys(known).length) { console.log('  ⚠️ 未能从结果页解析出正确答案，停止重做以免盲答'); break; }
    console.log('  从结果页解析到正确答案:', known, '→ 开始重做');
    // 点重做
    await page.locator('a:has-text("重做")').first().click();
    await sleep(2500);
    await page.locator('button:has-text("确定"), a:has-text("确定")').first().click().catch(() => {});
    // 借鉴：部分课程仅允许作答一次，重做轮会拿不到题目——保留当前成绩而不是让章节失败
    try {
      frame = await resolveWorkFrame(page); // 重做后可能在主 frame 也可能回到嵌套 iframe
    } catch (e) {
      console.log(`  ⚠️ 重做轮无法进入答题页（该课程可能仅允许作答一次），保留当前成绩 ${score}`);
      break;
    }
  }
  await page.close();
}

(async () => {
  if (!fs.existsSync(path.join(__dirname, 'storageState.json'))) {
    console.error('❌ 缺少 storageState.json，请先运行 npm run login');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(__dirname, 'logs'))) fs.mkdirSync(path.join(__dirname, 'logs'));

  let browser;
  try {
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo
    });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/i.test(e.message)) {
      console.error('❌ Playwright 浏览器未下载。请运行: npx playwright install chromium');
    } else {
      console.error('❌ 浏览器启动失败: ' + e.message.slice(0, 200));
    }
    process.exit(1);
  }
  const context = await browser.newContext({
    storageState: path.join(__dirname, 'storageState.json'),
    viewport: { width: 1440, height: 900 }
  });
  const seed = await context.newPage();
  await seed.goto('https://i.chaoxing.com/', { waitUntil: 'domcontentloaded' });
  if (/passport2\.chaoxing\.com\/login/.test(seed.url())) {
    console.error('❌ 会话过期，请重新运行 npm run login');
    await browser.close();
    process.exit(2); // 2 = 需要重新登录
  }

  const failed = [];
  for (const [label, kid] of Object.entries(config.chapterKids)) {
    try {
      await solveChapter(context, kid, label);
    } catch (e) {
      failed.push(label);
      console.error(`  ❌ ${label} 失败: ${e.message}`);
    }
    await sleep(2000);
  }
  await browser.close();
  console.log('\n===== 汇总 =====');
  console.log(failed.length
    ? `❌ ${failed.length} 个章节失败: ${failed.join('、')}（进程以非零码退出）`
    : '✅ 全部章节处理完毕。请到学习通核对最终成绩。');
  process.exitCode = failed.length ? 1 : 0;
})();
