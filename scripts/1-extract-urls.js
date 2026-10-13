// ============================================================
// 1-extract-urls.js
// 用法：进入课程"学生学习页面"(studentstudy) 后，F12 打开控制台粘贴运行
// 功能：① 列出所有"章节测试"任务点及其知识点ID
//       ② 递归遍历所有 iframe，提取当前打开的答题页完整 URL
// ============================================================
(() => {
  // ① 侧边栏所有章节测试的知识点 ID
  const tests = [...document.querySelectorAll('span')]
    .filter(s => (s.getAttribute('onclick') || '').includes('getTeacherAjax')
              && (s.title || '').includes('章节测试'))
    .map(s => ({
      // onclick 形如 getTeacherAjax('课程ID','班级ID','知识点ID')，取第 3 个数字串
      kid: (s.getAttribute('onclick').match(/[0-9]+/g) || [])[2] || '',
      name: (s.textContent || '').trim().replace(/\s+/g, ' ')
    }));

  // ② 递归 iframe 找答题页 URL（三层嵌套：studentstudy → knowledge/cards → work/index.html → doHomeWorkNew）
  const works = [];
  (function walk(win) {
    try {
      const h = win.location.href || '';
      if (/doHomeWorkNew|selectWorkQuestion/.test(h)) works.push(h);
      for (let i = 0; i < win.frames.length; i++) walk(win.frames[i]);
    } catch (e) { /* 跨域忽略 */ }
  })(window);

  console.log('== 章节测试任务点（kid 可用于拼 studentstudy URL 直接跳转） ==');
  tests.forEach(t => console.log(`${t.name}  →  ${t.kid}`));

  console.log('\n== 当前打开的测验/作业页 URL（完整复制！缺参数独立打开会报"无效的用户"） ==');
  if (!works.length) console.log('（当前页面没有打开的测验，先在课程里点开某个章节测试）');
  works.forEach(u => console.log(u));

  // 把结果挂到 window 上方便复制
  window.__cxExtract = { tests, works };
  console.log('\n结果已存到 window.__cxExtract，可用 copy(window.__cxExtract) 复制');
})();
