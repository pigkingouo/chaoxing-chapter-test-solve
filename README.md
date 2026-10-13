# chaoxing-chapter-test-solver

超星学习通（Chaoxing）章节测验自动作答工具。在真实课程（数据库原理，11 个章节测试）上完整跑通并沉淀了全部踩坑经验。

> ⚠️ **免责声明**：本项目仅供学习交流与自测辅助。请遵守所在学校/平台的学术规范与使用条款，因使用本项目产生的一切后果由使用者自行承担。

## 实测效果

| 章节 | 成绩 | 章节 | 成绩 |
|---|---|---|---|
| 第1章 | 89.7 | 第7章 | 90 |
| 第2章 | **100**（重做） | 第8章 | **100** |
| 第3章 | **100** | 第9章 | **100** |
| 第4章 | 90 | 第10章 | **100** |
| 第5章 | **100** | 第11章 | 75 |
| 第6章 | **100** | | |

## 它解决的核心难点

学习通的章节测验不是简单的"选完提交"，页面里埋了不少坑，本项目逐一处理：

1. **三层 iframe 嵌套**：答题页 `doHomeWorkNew` 藏在 `studentstudy → knowledge/cards → work/index.html` 里，必须递归遍历 frame 取出**完整 URL**（400+ 字符，带 enc 等令牌，缺一个参数独立打开就报"无效的用户"）
2. **字体反爬**：题目 DOM 文本是乱码，且渲染出的字形可能失真（实测"脏数据"显示成"虚数据"）。现已内置**本地字体解码**：解析页面内嵌的随机化 TTF，按"轮廓点绝对坐标 + on-curve 标志 → MD5"计算字形几何指纹，反查离线指纹表还原明文，读题不再依赖视觉识别（借鉴 [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing) 方案；本仓库为纯 Node 复刻、零第三方依赖，已与 fontTools 交叉验证 100% 一致）。无指纹表/解析失败/解码率过低时自动回退截图视觉模式
3. **选项随机打乱**：显示顺序 ≠ 题库原始顺序；选项上的 `data` 属性是每次渲染的随机标签，都不能当映射依据，必须按**选项内容**定位
4. **多选题是开关**：点已选项=取消；判分规则是"少选得部分分，错选得 0 分"
5. **填空题是 UEditor 富文本**：普通 textarea 赋值会被覆盖，必须走 `UE.instants` 编辑器实例 `setContent + sync`
6. **提交是页面内弹窗**：不是原生 confirm，需要点 DOM 里的"确定"
7. **重做机制**：部分测试可重做，且保留上次答案、选项顺序可能重排——用结果页的清晰文本正确答案做第 2 次满分冲刺

## 三种用法

### 方式一：Agent Skill（推荐，配合 AI 编程助手）

把 [`SKILL.md`](SKILL.md) 安装到你的 AI 助手技能目录（如 `~/.trae-cn/skills/` 或 `.agents/skills/`），然后对助手说：

> 帮我刷一下学习通数据库课程的章节测试

助手会按 skill 里的完整流程操作浏览器：定位测试 → 提取答题页 → 读题 → 作答 → 校验 → 提交 → 重做冲分。人工只需要完成登录（短信验证码）和最终确认。

### 方式二：控制台脚本（零安装，人工读题）

打开答题页后按 F12，依次粘贴 [`scripts/`](scripts/) 里的脚本：

| 脚本 | 运行位置 | 作用 |
|---|---|---|
| `1-extract-urls.js` | 课程学习页 | 列出全部章节测试知识点 ID + 当前答题页完整 URL |
| `2-answer-work.js` | 答题页 | 按你填的 `ANSWERS` 批量点选/填空，并输出校验结果 |
| `3-submit-work.js` | 答题页 | 提交 + 内容门控确认（只确认"确认提交"弹窗） |
| `4-read-score.js` | 结果页 | 读成绩、重做次数、逐题得分（提交后页面整页跳转，脚本上下文销毁，必须单独运行） |

自己读题（或问 AI）、把答案填进 `ANSWERS`，脚本负责繁琐的点击和校验，最后**人工目检再提交**。

### 方式三：Playwright + LLM 全自动

用多模态大模型（GPT-4o 等）截图读题并自动作答：

```bash
cd playwright-solver
npm install
npx playwright install chromium   # 必须：下载 Playwright 的 Chromium（漏掉会报"Executable doesn't exist"）
npm run login          # 手动登录一次，保存会话
cp config.example.json config.json   # 填入 LLM key 和课程参数
npm start
```

配置里 `studentstudyUrlTemplate` 从课程学习页的地址栏复制（把 `chapterId` 的值换成 `{kid}` 占位符），`chapterKids` 里列出要刷的章节（名称 → 知识点 ID，用方式一的脚本 1 可提取）。

流程：读题（**优先本地字体解码为明文**，解码不可用/题含图片时回退截图）→ LLM 判答 → 点击/填空 → 校验 → 提交 → 成绩低于 `minScore` 且可重做时，自动从结果页解析正确答案重做。

### 主要配置项（config.json）

| 配置 | 默认 | 说明 |
|---|---|---|
| `readMode` | `auto` | 读题模式：`auto` 解码文本优先、不佳回退截图；`text` 强制文本；`vision` 始终截图（旧行为） |
| `fontTable` | 空（内置表） | 字体指纹表路径（相对 playwright-solver 目录） |
| `guessOnFail` | `false` | 单选/多选两次获取失败时随机作答（保证章节可提交）；填空不适用 |
| `workRedoEnabled` | `true` | 是否自动重做冲分；**仅允许作答一次的课程建议设 `false`** |
| `workMaxRetries` | `3` | 最大重做轮数 |
| `minScore` | — | 达到该分数即停止重做 |
| `answerCache` | `true` | 答案缓存（重做模式自动跳过读缓存） |

## 字体指纹表与许可说明

`playwright-solver/resource/font_map_table.json`（字形指纹表）来自开源项目 [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing)（GPL-3.0，数据源同 [SocialSisterYi](https://github.com/SocialSisterYi/xuexiaoyi-to-xuexitong-tampermonkey-proxy)）。

- **个人学习自用**：无碍，本仓库直接内置以便开箱即用
- **公开分发/商业化前**：请自行评估 GPL-3.0 合规性——可选做法：从仓库移除该表（`git rm --cached` + 加入 .gitignore），使用时自行从上游项目获取放入同路径；表缺失时程序自动回退截图视觉模式，不影响运行
- 该表是"字形几何指纹 → 字符"的数据库，与超星页面每次随机生成的加密字体配合使用，不包含任何账号/答案数据

## AI 代理工具兼容性

| 你的工具 | 怎么用 | 额外要求 |
|---|---|---|
| WorkBuddy / TRAE | 装 SKILL.md 为技能，对话即用 | 无 |
| Claude Code | 装 SKILL.md，`claude --chrome` + 官方 Chrome 扩展 | Chrome + 扩展授权；无 JS evaluate，填空题建议走 playwright-solver |
| Cursor | 走 playwright-solver（内置 Browser 无 JS 执行，UEditor 填空/校验做不了） | OpenAI 兼容视觉模型 API Key |
| Codex CLI / OpenCode / DSH 等 CLI | 跑 `playwright-solver/`（Node 18+） | OpenAI 兼容视觉模型 API Key |
| 任意 MCP 客户端 | 外挂 Playwright MCP（含 browser_evaluate）后按 SKILL.md 流程 | MCP 配置 |

`playwright-solver` 只依赖 OpenAI 兼容 `/chat/completions`（非流式、不用 function-calling），兼容 DeepSeek/Qwen/GLM/Moonshot/SiliconFlow 及各类网关；密钥支持环境变量 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（优先于 config.json）。内置 429/5xx 指数退避重试、请求超时、JSON 解析兜底，失败时进程返回非零退出码，便于 CI/代理感知。

## 已知限制

- 登录必须人工完成（短信验证码）
- LLM 读题正确率取决于模型与题目清晰度，建议每次运行后核对成绩；重做机制可兜底
- 各校/各课程的页面结构可能有差异，选择器以 `SKILL.md` 为准微调
- 仅测试过 PC 网页端（mooc1.chaoxing.com），不适用于手机端

## 目录结构

```
├── SKILL.md              # Agent skill：完整工作流 + 陷阱清单（核心价值在这）
├── scripts/              # 浏览器控制台脚本（零安装）
│   ├── 1-extract-urls.js
│   ├── 2-answer-work.js
│   ├── 3-submit-work.js
│   └── 4-read-score.js
└── playwright-solver/    # 全自动版
    ├── login.js          # 手动登录保存会话
    ├── solve.js          # 自动作答主流程
    ├── font-decode.js    # 反爬字体本地解码器（纯 Node，零依赖）
    ├── resource/
    │   └── font_map_table.json   # 字形指纹表（见下方许可说明）
    ├── config.example.json
    └── package.json
```

## License

[MIT](LICENSE)
