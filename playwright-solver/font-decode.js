/**
 * font-decode.js — 超星学习通反爬字体（cxsecret）本地解码器
 *
 * 原理：超星在答题页的 <style id="cxSecretStyle"> 内嵌一份每次随机化的 TTF 字体，
 * 它把"文本码点"与"字形形状"的对应关系打乱——DOM 里是"假字"、渲染出的才是"真形状"。
 * 每个字形的几何形状是稳定的，对形状计算指纹（轮廓点绝对坐标 + on-curve 标志 → MD5），
 * 再用离线字形指纹表（hash → 真实字符）反查，即可把乱码文本还原为明文。
 *
 * 算法与开源实现（SocialSisterYi / Samueli924）的字形指纹方案逐位兼容；
 * 本文件为纯 Node 实现（零第三方依赖），走 code→gid→glyph 直连路径（不依赖字形命名规则）。
 *
 * 用法：
 *   const fd = require('./font-decode');
 *   const table = fd.loadGlyphTable(fd.DEFAULT_TABLE_PATH); // Map<hash, 字符>
 *   const fontMap = fd.buildFontMap(fd.decodeFontData(dataUrlOrB64)); // Map<码点, hash>
 *   const { text, missRate } = fd.decrypt(fontMap, table, garbledText);
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TABLE_PATH = path.join(__dirname, 'resource', 'font_map_table.json');

// ---------- sfnt 基础 ----------
const u16 = (b, o) => b.readUInt16BE(o);
const i16 = (b, o) => b.readInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

function sfntBase(buf) {
  // TTC（字体集合）：取第一个字体
  if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'ttcf') return u32(buf, 12);
  return 0;
}

function findTable(buf, tag) {
  const base = sfntBase(buf);
  const numTables = u16(buf, base + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === tag) {
      return { offset: u32(buf, rec + 8), length: u32(buf, rec + 12) };
    }
  }
  return null;
}

// ---------- glyf：字形几何指纹 ----------
// 与参考实现逐位对齐：按轮廓逐点拼接 `${x}${y}${onCurveFlag}`（无分隔符），MD5(utf8)。
// x/y 为还原后的绝对坐标；onCurveFlag = 原始 flag & 0x01。
function glyphHash(buf, glyfOff, loca, gid) {
  const start = glyfOff + loca[gid];
  const end = glyfOff + loca[gid + 1];
  if (end <= start) return null;           // 空字形
  let p = start;
  const nContours = i16(buf, p);
  p += 2;
  if (nContours <= 0) return null;         // 复合字形 / 无轮廓：与参考实现一致，跳过
  p += 8;                                  // bbox
  const endPts = new Array(nContours);
  for (let i = 0; i < nContours; i++) { endPts[i] = u16(buf, p); p += 2; }
  const nPts = endPts[nContours - 1] + 1;
  p += 2 + u16(buf, p);                    // instructionLength + instructions

  // flags（展开 repeat）
  const flags = new Uint8Array(nPts);
  for (let i = 0; i < nPts;) {
    const f = buf[p++];
    flags[i++] = f;
    if (f & 0x08) {
      let rep = buf[p++];
      while (rep-- > 0 && i < nPts) flags[i++] = f;
    }
  }

  // x 坐标：delta 累加还原为绝对坐标
  const xs = new Array(nPts);
  let v = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & 0x02) { const d = buf[p++]; v += (f & 0x10) ? d : -d; }
    else if (!(f & 0x10)) { v += i16(buf, p); p += 2; }
    xs[i] = v;
  }
  // y 坐标
  const ys = new Array(nPts);
  v = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & 0x04) { const d = buf[p++]; v += (f & 0x20) ? d : -d; }
    else if (!(f & 0x20)) { v += i16(buf, p); p += 2; }
    ys[i] = v;
  }

  // 指纹串
  let s = '';
  let last = 0;
  for (let i = 0; i < nContours; i++) {
    for (let j = last; j <= endPts[i]; j++) s += `${xs[j]}${ys[j]}${flags[j] & 1}`;
    last = endPts[i] + 1;
  }
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

// ---------- cmap：码点 → 字形ID ----------
function parseFormat4(buf, off, map) {
  const segCount = u16(buf, off + 6) / 2;
  const endOff = off + 14;
  const startOff = endOff + segCount * 2 + 2;
  const deltaOff = startOff + segCount * 2;
  const rangeOff = deltaOff + segCount * 2;
  for (let i = 0; i < segCount; i++) {
    const end = u16(buf, endOff + i * 2);
    const start = u16(buf, startOff + i * 2);
    const delta = i16(buf, deltaOff + i * 2);
    const ro = u16(buf, rangeOff + i * 2);
    if (start === 0xFFFF) continue;
    for (let c = start; c <= end; c++) {
      let gid;
      if (ro === 0) {
        gid = (c + delta) & 0xFFFF;
      } else {
        const idx = rangeOff + i * 2 + ro + (c - start) * 2;
        if (idx + 2 > buf.length) break;
        gid = u16(buf, idx);
        if (gid !== 0) gid = (gid + delta) & 0xFFFF;
      }
      if (gid !== 0 && !map.has(c)) map.set(c, gid);
    }
  }
}

function parseFormat6(buf, off, map) {
  const first = u16(buf, off + 6);
  const count = u16(buf, off + 8);
  for (let i = 0; i < count; i++) {
    const gid = u16(buf, off + 10 + i * 2);
    const c = first + i;
    if (gid !== 0 && !map.has(c)) map.set(c, gid);
  }
}

function parseFormat12(buf, off, map) {
  const n = u32(buf, off + 12);
  let p = off + 16;
  let budget = 300000; // 防御：坏字体分组过大时截断
  for (let i = 0; i < n && budget > 0; i++) {
    const sc = u32(buf, p);
    const ec = u32(buf, p + 4);
    const sg = u32(buf, p + 8);
    p += 12;
    for (let c = sc; c <= ec && c <= 0x10FFFF && budget > 0; c++, budget--) {
      const gid = sg + (c - sc);
      if (gid !== 0 && !map.has(c)) map.set(c, gid);
    }
  }
}

function buildCmap(buf) {
  const tab = findTable(buf, 'cmap');
  const map = new Map();
  if (!tab) return map;
  const n = u16(buf, tab.offset + 2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const rec = tab.offset + 4 + i * 8;
    const plat = u16(buf, rec);
    const enc = u16(buf, rec + 2);
    const off = tab.offset + u32(buf, rec + 4);
    const isUnicode = plat === 0 || (plat === 3 && (enc === 0 || enc === 1 || enc === 10));
    if (!isUnicode) continue;
    // 优先级：3,10 > 3,1 > 3,0 > 0,x
    const prio = (plat === 3 && enc === 10) ? 0 : (plat === 3 && enc === 1) ? 1 : (plat === 3) ? 2 : 3;
    subs.push({ off, prio });
  }
  subs.sort((a, b) => a.prio - b.prio);
  for (const sub of subs) {
    const fmt = u16(buf, sub.off);
    try {
      if (fmt === 4) parseFormat4(buf, sub.off, map);
      else if (fmt === 6) parseFormat6(buf, sub.off, map);
      else if (fmt === 12) parseFormat12(buf, sub.off, map);
    } catch (e) { /* 单个子表损坏不阻断 */ }
  }
  return map;
}

// ---------- 对外 API ----------

/** data:...;base64,xxx / 裸 base64 → Buffer */
function decodeFontData(dataUrlOrB64) {
  const idx = dataUrlOrB64.indexOf('base64,');
  const b64 = idx >= 0 ? dataUrlOrB64.slice(idx + 7) : dataUrlOrB64;
  return Buffer.from(b64, 'base64');
}

/**
 * 构建"码点 → 字形指纹"映射（针对当次页面加载的随机字体）。
 * @param {Buffer} ttf ttf 二进制
 * @returns {Map<number,string>}
 */
function buildFontMap(ttf) {
  const result = new Map();
  const glyfTab = findTable(ttf, 'glyf');
  const locaTab = findTable(ttf, 'loca');
  const head = findTable(ttf, 'head');
  const maxp = findTable(ttf, 'maxp');
  if (!glyfTab || !locaTab || !head || !maxp) return result; // CFF/OTF 或非 TTF：返回空，调用方回退
  const numGlyphs = u16(ttf, maxp.offset + 4);
  const longLoca = i16(ttf, head.offset + 50) !== 0;
  const loca = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = longLoca ? u32(ttf, locaTab.offset + i * 4) : u16(ttf, locaTab.offset + i * 2) * 2;
  }
  const gidCache = new Map();
  for (const [code, gid] of buildCmap(ttf)) {
    let h = gidCache.get(gid);
    if (h === undefined) {
      h = glyphHash(ttf, glyfTab.offset, loca, gid) || null;
      gidCache.set(gid, h);
    }
    if (h) result.set(code, h);
  }
  return result;
}

/** 加载离线字形指纹表（{"字形名": "hash"}）并反转为 Map<hash, 字符> */
function loadGlyphTable(jsonPath = DEFAULT_TABLE_PATH) {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
  const hashToChar = new Map();
  for (const [name, hash] of Object.entries(raw)) {
    let ch = null;
    const m = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) || /^u([0-9A-Fa-f]{5,6})$/.exec(name);
    if (m) {
      try { ch = String.fromCodePoint(parseInt(m[1], 16)); } catch (e) { ch = null; }
    } else if ([...name].length === 1) {
      ch = name; // 单字符名（如 "A"、"%"）直接可用
    }
    if (ch && !hashToChar.has(hash)) hashToChar.set(hash, ch);
  }
  return hashToChar;
}

// 康熙部首 → 对应汉字（与参考实现一致的对照表）
const KX_RADICALS = '⼀⼁⼂⼃⼄⼅⼆⼇⼈⼉⼊⼋⼌⼍⼎⼏⼐⼑⼒⼓⼔⼕⼖⼗⼘⼙⼚⼛⼜⼝⼞⼟⼠⼡⼢⼣⼤⼥⼦⼧⼨⼩⼪⼫⼬⼭⼮⼯⼰⼱⼲⼳⼴⼵⼶⼷⼸⼹⼺⼻⼼⼽⼾⼿⽀⽁⽂⽃⽄⽅⽆⽇⽈⽉⽊⽋⽌⽍⽎⽏⽐⽑⽒⽓⽔⽕⽖⽗⽘⽙⽚⽛⽜⽝⽞⽟⽠⽡⽢⽣⽤⽥⽦⽧⽨⽩⽪⽫⽬⽭⽮⽯⽰⽱⽲⽳⽴⽵⽶⽷⽸⽹⽺⽻⽼⽽⽾⽿⾀⾁⾂⾃⾄⾅⾆⾇⾈⾉⾊⾋⾌⾍⾎⾏⾐⾑⾒⾓⾔⾕⾖⾗⾘⾙⾚⾛⾜⾝⾞⾟⾠⾡⾢⾣⾤⾥⾦⾧⾨⾩⾪⾫⾬⾭⾮⾯⾰⾱⾲⾳⾴⾵⾶⾷⾸⾹⾺⾻⾼髙⾽⾾⾿⿀⿁⿂⿃⿄⿅⿆⿇⿈⿉⿊⿋⿌⿍⿎⿏⿐⿑⿒⿓⿔⿕⺠⻬⻩⻢⻜⻅⺟⻓';
const KX_NORMAL = '一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉采里金長門阜隶隹雨青非面革韋韭音頁風飛食首香馬骨高高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠民齐黄马飞见母长';
const KX_MAP = new Map([...KX_RADICALS].map((c, i) => [c, KX_NORMAL[i]]));

function fixRadicals(s) {
  let out = '';
  for (const ch of s) out += KX_MAP.get(ch) || ch;
  return out;
}

/**
 * 解码乱码文本。
 * @param {Map<number,string>} fontMap  buildFontMap 结果
 * @param {Map<string,string>} table    loadGlyphTable 结果
 * @param {string} text 页面提取的乱码文本
 * @returns {{text: string, decoded: number, missed: number, missRate: number}}
 */
function decrypt(fontMap, table, text) {
  let out = '';
  let decoded = 0;
  let missed = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const h = fontMap.get(cp);
    const real = h ? table.get(h) : null;
    if (real) { out += real; decoded++; }
    else {
      out += ch;
      if (cp >= 0x2E80) missed++; // 只看 CJK/部首区：非中文字符（数字/字母/标点）不解码属正常
    }
  }
  out = fixRadicals(out);
  const total = decoded + missed;
  return { text: out, decoded, missed, missRate: total ? missed / total : 0 };
}

module.exports = {
  DEFAULT_TABLE_PATH,
  decodeFontData,
  buildFontMap,
  buildCmap,
  loadGlyphTable,
  decrypt,
  fixRadicals,
  // 供交叉验证使用的底层函数
  _glyphHash: (ttf, gid) => {
    const glyfTab = findTable(ttf, 'glyf');
    const locaTab = findTable(ttf, 'loca');
    const head = findTable(ttf, 'head');
    const maxp = findTable(ttf, 'maxp');
    if (!glyfTab || !locaTab || !head || !maxp) return null;
    const numGlyphs = u16(ttf, maxp.offset + 4);
    if (gid >= numGlyphs) return null;
    const longLoca = i16(ttf, head.offset + 50) !== 0;
    const loca = new Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) {
      loca[i] = longLoca ? u32(ttf, locaTab.offset + i * 4) : u16(ttf, locaTab.offset + i * 2) * 2;
    }
    return glyphHash(ttf, glyfTab.offset, loca, gid);
  },
  _numGlyphs: (ttf) => {
    const maxp = findTable(ttf, 'maxp');
    return maxp ? u16(ttf, maxp.offset + 4) : 0;
  }
};
