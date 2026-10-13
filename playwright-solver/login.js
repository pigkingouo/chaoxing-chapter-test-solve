/**
 * login.js — 手动登录一次，保存会话到 storageState.json
 * 运行：npm run login
 * 浏览器打开后手动完成登录（账号密码/短信验证码），看到个人空间后回到终端按回车。
 */
const { chromium } = require('playwright');
const readline = require('readline');

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/i.test(e.message)) {
      console.error('❌ Playwright 浏览器未下载。请运行: npx playwright install chromium');
    } else {
      console.error('❌ 浏览器启动失败: ' + e.message.slice(0, 200));
    }
    process.exit(1);
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://passport2.chaoxing.com/login?newversion=true&refer=https%3A%2F%2Fi.chaoxing.com');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(res => rl.question('登录完成（能看到个人空间首页）后，在这里按回车...', res));
  rl.close();

  await ctx.storageState({ path: __dirname + '/storageState.json' });
  console.log('✅ 会话已保存到 storageState.json');
  await browser.close();
})();
