---
name: chaoxing-chapter-test-solver
description: 自动完成超星学习通（Chaoxing）课程的章节测验：定位测试任务点、提取答题页、读题作答（单选/多选/填空）、提交查分、利用重做机制冲满分。当用户要求"刷学习通章节测试 / 章节测验 / 网课作业"时使用。需要在已登录学习通的浏览器环境中执行。
agent_created: true
---

# 学习通章节测试自动作答

本 skill 沉淀了在真实课程（数据库课程，11 章）上完整跑通的流程与全部踩坑经验。

## 前置条件

- 浏览器已登录学习通（i.chaoxing.com 能看到个人空间）；登录涉及短信验证码，必须由用户完成
- 已进入某门课程的"学生学习页面"（URL 形如 `mooc1.chaoxing.com/mycourse/studentstudy?chapterId=...&courseId=...&clazzid=...&cpi=...&enc=...`）
- 涉及浏览器操作的工具（browser_* 系列）或 Playwright
- playwright-solver 本地字体解码需要 `playwright-solver/resource/font_map_table.json` 字形指纹表（仓库已内置；缺失时自动回退截图视觉模式，不影响流程）

## Agent 兼容矩阵（先确认走哪条路径）

不同代理工具的浏览器能力差异极大，执行前先按下表选路径；若两条路径都不可用，按"回退链"降级：

| 代理工具 | 推荐路径 | 工具名差异/适配点 |
|---|---|---|
| WorkBuddy / TRAE | 内置 `browser_*` 工具族直接执行本 skill | 工具名即本文所写（browser_navigate/click/snapshot/evaluate…） |
| Claude Code | `claude --chrome` + 官方 Chrome 扩展 | 工具名为 Chrome 扩展注入；首次使用需用户授权；**验证码/登录会自动暂停交人工**。扩展无通用 JS evaluate：单选/多选可用 UI 点击完成，**填空（UEditor）与 class 校验不可靠**——填空题建议走 playwright-solver，或键入后截图人工核对 |
| Cursor | ⚠️ 内置 Browser（2.0 GA）**无 JS 执行能力**（仅导航/点击/输入/滚动/截图/console/network） | 本流程的注入辅助、UEditor 填空、答案校验都依赖 evaluate → **建议直接走 playwright-solver**；用内置浏览器只能完成选择题主干，填空需人工键入 |
| OpenCode / DSH / 通用 CLI | 无内置浏览器 → 走 `playwright-solver/` 全自动脚本 | 仅需 Node 18+ 与 OpenAI 兼容视觉模型 API（`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` 环境变量注入）。DSH 可装 `dsh-browser-playwright` 插件，但其快照驱动模式同样无 JS 执行，填空仍受限 |
| Codex CLI | 无浏览器能力 → 只能走 `playwright-solver/`，或退化为人工辅助 | CLI 自带 `--search` 仅为联网搜索，不能操作页面 |
| 任意支持 MCP 的工具 | 外挂 **Playwright MCP**（含 browser_evaluate）后按本 skill 流程执行 | 官方 Playwright MCP 工具名与 browser_* 大体对应（browser_navigate/browser_snapshot/browser_click/browser_evaluate），语义一致即可套用 |

**JS 执行能力是硬门槛**：本流程有 3 步必须在页面内跑 JS（注入辅助函数、UEditor `setContent` 填空、按 class 校验选中态）。所用的浏览器路径必须提供 evaluate 类工具，否则只能完成"读题+点选项"主干，填空题与校验环节降级为人工。

**回退链（能力逐级降级，禁止跳级）**：
1. 内置浏览器工具（WorkBuddy/Claude Code/Cursor）
2. `playwright-solver`（任何能跑 Node 的环境）
3. `scripts/` 控制台脚本（1 提取 URL / 2 作答 / 3 提交 / 4 读分；代理给指令，**人**在 F12 控制台粘贴执行）
4. 以上全部不可用 → 停止并向用户说明缺什么（不要凭空模拟操作结果）

## LLM API 兼容性约定（playwright-solver）

- 仅使用 **OpenAI 兼容 `/chat/completions`、非流式（显式 `stream:false`）、不依赖 function-calling**——DeepSeek/Qwen/GLM/Moonshot/SiliconFlow/OpenAI 及各类兼容网关均可直连
- 读题模型要求取决于读题路径：**本地字体解码可用时（默认 auto 模式）送纯文本，纯文本模型即可**；解码不可用或题含图片时回退截图，需要支持图像输入（vision）的多模态模型（`gpt-4o` / `glm-4v` 等）
- 内置：请求超时（`llm.timeoutMs`，默认 120s）、429/5xx 指数退避重试（`llm.maxRetries`，默认 3，尊重 Retry-After）、JSON 解析兜底重试
- 密钥注入顺序：环境变量 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` > config.json

## 页面结构（核心概念）

```
学生学习页面 (studentstudy)
├─ 左侧目录: span.posCatalog_name[title*="章节测试"]
│    onclick="getTeacherAjax('课程ID','班级ID','知识点ID')"  ← 每章测试的 knowledgeId
└─ iframe: mooc-ans/knowledge/cards?knowledgeid=...
   └─ iframe: ananas/modules/work/index.html
      └─ iframe: mooc-ans/work/doHomeWorkNew?courseId=...&workId=...&enc=...  ← 答题页（真身）
```

答题页元素：
- 题目容器 `.TiMu`（按 DOM 顺序即题号 1..N）
- 单选选项 `li[onclick*="addChoice"]`，多选选项 `li[onclick*="addMultipleChoice"]`
- 选项内的 `span.num_option`（选中后加 class `check_answer`；多选是 `num_option_dx` + `check_answer_dx`）
- 每题自己的隐藏答案域：`input[type=hidden][name^=answer][name$=数字]`（值 = 已选项的 data 属性拼接）
- 填空题：UEditor 富文本编辑器（textarea `id^=answerEditor` 是它的后备域），编辑器实例在 `window.UE.instants`

## 工作流

### 1. 收集所有章节测试的知识点 ID

在 studentstudy 页面执行：

```js
[...document.querySelectorAll('span')]
  .filter(s => (s.getAttribute('onclick')||'').includes('getTeacherAjax')
            && (s.title||'').includes('章节测试'))
  .map(s => ({ kid: s.getAttribute('onclick').split(',')[2].replace(/\D/g,''),
               name: (s.textContent||'').trim() }));
```

### 2. 打开某一章并提取答题页完整 URL

直接导航 `studentstudy?chapterId={kid}&...`（沿用当前 URL 其他参数），等 5-6 秒加载，然后**递归遍历所有层级的 window.frames**，找 `location.href` 含 `doHomeWorkNew` 的 frame，取其**完整 URL**（可能 400+ 字符，严禁截断）。

把该 URL 用新标签页打开即可独立答题。缺任何 token 参数（尤其 `enc`）都会报"无效的用户"。

### 3. 读题（字体反爬！两条路径）

答题页 DOM 文本被反爬字体混淆（元素带 `font-cxsecret` 类），innerText 是乱码，且**渲染出来的字形也可能失真**（实测"脏数据"渲染成"虚数据"）。

**路径 A（首选，playwright-solver 内置）：本地字体解码**

- 页面 `<style id="cxSecretStyle">` 内嵌一份随机化 TTF（把"文本码点"与"字形形状"的对应打乱），配合离线字形指纹表 `playwright-solver/resource/font_map_table.json` 可**离线还原明文**，不再依赖视觉识别
- 原理：每个字形的几何形状稳定 → 对轮廓点绝对坐标 + on-curve 标志算 MD5（无分隔符拼接）→ 在指纹表反查真实字符。算法与 Samueli924/chaoxing、SocialSisterYi 等开源实现逐位兼容；本仓库为纯 Node 复刻（`font-decode.js`，零第三方依赖），已用 fontTools 交叉验证（黑体 28558 个字形哈希 100% 一致）
- 解码质量自动判定：未解码率（CJK 字符口径）≤20% 用解码文本出题；无字体加密的页面直接按明文；否则该题自动回退截图
- 配置：`readMode` = `auto`（默认）/ `text`（强制文本）/ `vision`（旧行为，始终截图）；`fontTable` 可指定指纹表路径
- 题含图片/公式时自动附截图（文本 + 图片双通道）

**路径 B（回退）：截图 + 视觉识别**

- 无指纹表 / 字体解析失败 / 解码率过低时自动使用（或 `readMode=vision` 强制）
- **逐题截图，禁止整页拼接脑补**：对每题容器（.TiMu）单独截图（或滚动到题干首尾行均完整可见再截）。题干含数字/条件时必须逐字转述后才允许作答；发现题干疑似被截断/遮挡/跨屏断开，必须补截，**禁止按"经典题型"套用默认参数**
- 题干里的否定词（不在/没有/不正确）、图表、公式要重点甄别，必要时二次确认
- **判断题抠字眼按教材定义原文**：出现"集合/序列/有序/有限/线性"等定义词时，按教材标准定义判断而非日常直觉（如数组是"同类型数据元素的有限**序列**"→"是集合"判错；树是"n≥0 个结点的有限**集**"）。直觉与定义冲突时以定义为准

提交后的结果页（`selectWorkQuestionYiPiYue?...&submit=true`）是**清晰文本**，可用来核对每题得分与正确答案（两种路径通用）。

### 4. 作答

```js
// 单选/多选：按"屏幕上显示的选项内容"点击对应位置的 li
// ⚠️ 多选答案按字母序点击（乱序可能导致提交失败）
const lis = [...tm.querySelectorAll('li')].filter(li =>
  /addChoice|addMultipleChoice/.test(li.getAttribute('onclick')||''));
lis[idx].click();

// 填空：UEditor 按题内 DOM 顺序填充
const insts = Object.values(window.UE.instants).filter(e => tm.contains(e.iframe))
  .sort((a,b) => (a.iframe.compareDocumentPosition(b.iframe) & 4) ? -1 : 1);
insts.forEach((ed, n) => { ed.setContent(答案[n]); try { ed.sync(); } catch(e){} });
```

### 5. 校验

- 点击校验：检查每题 `span` 的 `check_answer` class 位置是否与预期一致（注意多选的 class 是 `check_answer_dx`）
- **必须截图目检高亮选项的实际内容**与答案一致（data 属性是每次渲染的随机标签，不可用于映射）
- 多选题：**少选得部分分，错选得 0 分**——没把握的选项宁可不选

### 6. 提交

点"提交"按钮 → 页面内弹出"确认提交？"对话框 → 点其中的"确定"（这是 DOM 按钮不是原生弹窗）→ 跳转到结果页。结果页读取：`最终成绩/本次成绩 XX分`、每题得分、`重做 (剩余 N 次)` 链接。

### 7. 重做冲满分

结果页若有"重做"链接（且剩余次数 ≥1）：

1. 点击重做 → 确认"之前答题内容会保留" → 进入第 2 次作答，**已答内容保留、题目选项顺序可能与上次不同**
2. 从结果页（清晰文本）解析每题正确答案与错误原因
3. 只修改错题：按**选项内容**重新定位并点击（单选直接点新项；多选是开关，点已选项=取消）
4. 重新校验、提交

注意：
- 部分测试只允许 1 次作答（无重做链接）；重做后最终成绩以最新/最高为准（实测第 2 章 80→100）
- 重做轮可能直接拿不到题目（仅允许一次作答的课程）——此时应**保留上一轮成绩**并提示，不要按章节失败处理
- playwright-solver 配置：`workRedoEnabled`（默认 true，仅允许作答一次的课程建议设 false）、`workMaxRetries`（默认 3）

## 关键陷阱清单（必读）

1. **iframe 嵌套三层**，必须递归 walk window.frames，逐个比对 `location.href`
2. **URL 不能截断**——提取时严禁 `.slice()` 限制长度，缺 enc/classId 等参数独立打开会失败
3. **选项随机打乱**：显示顺序 ≠ 原始题库顺序；只能按内容定位选项
4. **data 属性是每次渲染的随机标签**，不是原始字母，不可用于映射答案
5. **多选是 toggle**：点已选项=取消，点未选项=选中；修改答案前先弄清当前选中状态
6. **反爬字体会视觉误导**（脏→虚）：优先走本地字体解码（路径 A）；视觉模式下关键答案词若存疑，提交后到结果页用清晰文本核对
7. **addChoice 是切换不是叠加**：单选点新项自动切旧项；多选点两项=先选中后取消
8. 隐藏 input 的 answer 值是"已选项 data 属性拼接"，仅能证明"选了"，不能证明"选对了"
9. 同一章节重做时**保留上次答案**——只需修改错题，别把对的题弄乱
10. 页面长时间无操作会弹"系统将刷新页面"提示，答题节奏别太慢
11. **控制台脚本随整页跳转销毁**：脚本 3 确认提交后无法在同一上下文读成绩，必须在跳转后的结果页单独运行脚本 4
12. **已完成章节没有答题页**：内嵌的是已批阅页（selectWorkQuestionYiPiYue），递归查找 doHomeWorkNew 会失败——这不是故障，按"已完成"处理或走重做流程
13. 确认弹窗要做**内容门控**：只点包含"确认提交"的弹窗里的"确定"，其他"确定"弹窗（如"有题目未作答"）必须中止带回内容，防止无人值守时误确认
14. 多选题答案比较要**排序后比对**：LLM 返回 "ADB"、页面存储 "ABD" 是同一答案，直接字符串比较会误报校验失败
15. **多选题点击/提交必须按字母序**（"ABD" 而非 "ADB"）——乱序可能导致提交失败（实测自参考项目）
16. **本地字体解码依赖指纹表**：`resource/font_map_table.json` 缺失/损坏时自动回退截图模式，不影响流程；表含 GPL-3.0 开源项目数据，个人自用无碍，公开发布前请阅 README 许可说明
17. **随机作答兜底（guessOnFail）** 默认关闭：开启后仅对单选/多选在两次获取失败时随机作答（保证章节可提交），填空不适用仍中止；随机答案不写入答案缓存
18. **题干完整性强制校验（浏览器视觉路径）**：整页滚动截图最易丢题干的数字与条件——实测"以列序为主序"被截断，导致按行主序经典公式整题错选。含地址/公式计算的题必须逐字核对全部参数（主序方向、基地址、下标起点、元素大小）后作答
19. **教师题库标准答案可能与教材理论冲突**（实测"广义表可以是多层次的表"被判错，平台标准答案为"广义表是一维广义表"）：此类题无法预判，但同一课程题库口径常复用——每章提交后记录结果页错题的平台口径，后续章节遇到同知识点按平台口径作答，别再按教材理论硬推
20. **结果页读取要自洽校验**：出现"我的答案 = 正确答案却得 0 分"这类矛盾时，说明字段读取错位或题库标注异常，必须截图核对原文后再采信，不要直接把该题当错题分析

## 免责声明

本工具仅供学习交流与自测辅助。请遵守所在学校/平台的学术规范与使用条款，因使用本工具产生的一切后果由使用者自行承担。
