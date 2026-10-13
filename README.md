# chaoxing-chapter-test-solver

学习通（超星）章节测验自动答题工具，有四种用法：把链接丢给 AI 助手、安装为技能、本地脚本全自动刷、浏览器控制台半自动刷。

> ⚠️ **免责声明**：本项目仅供学习交流与自测辅助。请遵守所在学校/平台的学术规范与使用条款，因使用本项目产生的一切后果由使用者自行承担。

## 用法一：直接把仓库链接发给 AI 助手

最省事的方式：复制这个仓库地址，发给你正在用的 AI 编程助手（WorkBuddy、TRAE、Claude Code 等），一句话：

> 读取 <https://github.com/pigkingouo/chaoxing-chapter-test-solve> 里的 SKILL.md，按上面的流程帮我刷学习通章节测试

助手联网读完 SKILL.md 就能开工。前提是你的助手有网页访问能力（内置浏览器或网页读取工具）。

## 用法二：安装为 AI 助手技能

把 [SKILL.md](SKILL.md) 放进你 AI 助手的技能目录（如 `~/.trae-cn/skills/` 或 `.agents/skills/`），之后直接对话：

> 帮我刷一下学习通数据库课程的章节测试

助手会自动完成定位测试、读题、作答、提交、重做的全流程。你只需要做两件事：扫码/验证码登录，最后确认成绩。

不同助手的能力有差异，适配情况：

| 你的工具                         | 怎么用                                         | 备注                        |
| ---------------------------- | ------------------------------------------- | ------------------------- |
| WorkBuddy / TRAE             | 装 SKILL.md 即可                               | 无额外要求                     |
| Claude Code                  | 装 SKILL.md，`claude --chrome` + 官方 Chrome 扩展 | 填空题建议改用 playwright-solver |
| Cursor                       | 建议 playwright-solver                        | 内置浏览器无法执行 JS，填空做不了        |
| Codex / OpenCode / DSH 等 CLI | playwright-solver                           | 无浏览器能力                    |
| 任意 MCP 客户端                   | 外挂 Playwright MCP 后按 SKILL.md 走             | 需要 browser\_evaluate 工具   |

## 用法三：Playwright 全自动脚本

不需要 AI 助手，本地跑脚本，用大模型 API 读题：

```bash
cd playwright-solver
npm install
npx playwright install chromium   # 下载浏览器内核，必须执行
npm run login                     # 手动登录一次，保存会话
copy config.example.json config.json   # 填入 LLM key 和课程参数
npm start
```

`config.json` 里的 API Key 兼容所有 OpenAI 格式的接口（DeepSeek、Qwen、GLM、Moonshot、SiliconFlow 等），也可以用环境变量 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 注入。

脚本会自动读题作答、提交，分数不理想且还有重做机会时会自动分析错题重刷。

## 用法四：浏览器控制台脚本（零安装）

不想装任何东西？打开学习通答题页，按 F12 打开控制台，依次粘贴 [scripts/](scripts/) 里的脚本：

| 脚本                  | 在哪运行  | 干什么         |
| ------------------- | ----- | ----------- |
| `1-extract-urls.js` | 课程学习页 | 列出所有章节测试的地址 |
| `2-answer-work.js`  | 答题页   | 按你填的答案批量作答  |
| `3-submit-work.js`  | 答题页   | 提交          |
| `4-read-score.js`   | 结果页   | 读成绩和正确答案    |

题目自己读（也可以把截图丢给 AI），答案填进脚本的 `ANSWERS` 变量，脚本负责点击和校验，提交前记得人工检查一遍。

## 注意事项

- 登录必须人工完成（有短信验证码）
- 各学校课程页面结构可能略有差异，如遇异常参考 SKILL.md 里的选择器
- 仅支持 PC 网页端，手机端不适用
- 字体指纹表来自开源项目 [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing)（GPL-3.0），个人自用没问题，如需二次分发请自行评估合规性；删掉该表不影响运行，会自动回退到截图识别模式

## 目录结构

```
├── SKILL.md              # AI 助手技能文件（核心）
├── scripts/              # 控制台脚本（零安装）
└── playwright-solver/    # 全自动脚本
    ├── login.js          # 登录保存会话
    ├── solve.js          # 自动作答主流程
    └── font-decode.js    # 反爬字体解码
```

## License

[MIT](LICENSE)
