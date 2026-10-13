// ============================================================
// 3-submit-work.js
// 用法：在"做作业"(doHomeWorkNew) 答题页控制台运行（先运行过 2-answer-work.js 并人工核对）
// 功能：点提交 → 轮询并只确认包含"确认提交"的弹窗
//
// ⚠️ 已知边界：确认提交后页面整页跳转，本脚本的后续代码不会执行（控制台脚本
//    无法跨文档存活）。成绩请在跳转完成后的结果页运行 4-read-score.js 读取。
// ============================================================
(async () => {
  const visibleBtns = txt => [...document.querySelectorAll('button, a')]
    .filter(b => (b.textContent || '').trim() === txt && b.offsetParent !== null);

  const submit = visibleBtns('提交')[0];
  if (!submit) { console.log('❌ 未找到"提交"按钮'); return; }
  submit.click();

  // 轮询确认弹窗（最多约 10s）；只点包含"确认提交"的弹窗中的"确定"，
  // 其他"确定"弹窗（如"有题目未作答"）不盲目确认，打印内容供人工判断
  let confirmed = false;
  for (let i = 0; i < 7 && !confirmed; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const btns = visibleBtns('确定');
    for (const b of btns) {
      const scope = b.closest('[class*="dialog"],[class*="modal"],[class*="mask"],[class*="layer"],[class*="pop"]')
        || b.parentElement?.parentElement || document.body;
      const txt = (scope.textContent || '').replace(/\s+/g, ' ');
      if (txt.includes('确认提交')) { b.click(); confirmed = true; break; }
      console.log('⚠️ 出现非"确认提交"弹窗，未自动确认: ' + txt.slice(0, 100));
    }
  }
  console.log(confirmed
    ? '✅ 已确认提交。页面即将跳转，请等跳转完成后运行 4-read-score.js 读取成绩'
    : '⚠️ 未捕获"确认提交"弹窗。若页面已跳转，直接运行 4-read-score.js');
})();
