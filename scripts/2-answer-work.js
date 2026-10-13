// ============================================================
// 2-answer-work.js
// 用法：在"做作业"(doHomeWorkNew) 答题页的控制台粘贴运行
// 前置：先改下面的 ANSWERS（题号 → 答案），运行后人工核对！
//
// 答案格式：
//   单选:  1: "C"
//   多选:  2: "ABD"          （直接连写字母）
//   填空:  3: ["数据库管理系统"]  （数组，按空顺序）
//
// ⚠️ 重要：
//   - 页面文字被反爬字体混淆，题号顺序仍按 .TiMu 的 DOM 顺序（即页面上显示的第 N 题）
//   - 选项显示顺序是随机的，请对着屏幕上选项的"内容"确认字母再填 ANSWERS
//   - 多选题少选得部分分、错选得 0 分，没把握的选项宁可不选
// ============================================================
const ANSWERS = {
  // 1: "C",
  // 2: "ABD",
  // 3: ["数据库管理系统"],
};

(() => {
  const timus = [...document.querySelectorAll('.TiMu')];
  if (!timus.length) return console.log('❌ 未找到题目(.TiMu)，确认当前在 doHomeWorkNew 答题页');

  const isChoiceLi = li => /addChoice|addMultipleChoice/.test(li.getAttribute('onclick') || '');
  const checkedOf = lis => lis
    .map((li, n) => { const sp = li.querySelector('span'); return sp && /check_answer/.test(sp.className) ? 'ABCD'[n] : null; })
    .filter(x => x).join('');

  timus.forEach((tm, i) => {
    const no = i + 1, ans = ANSWERS[no];
    if (!ans) return;
    const lis = [...tm.querySelectorAll('li')].filter(isChoiceLi);

    if (typeof ans === 'string') {
      // —— 单选 / 多选 ——
      // 多选是开关：先取消所有已选项，再点目标项，保证结果=ANSWERS
      lis.forEach(li => {
        const sp = li.querySelector('span');
        if (sp && /check_answer/.test(sp.className)) li.click();
      });
      for (const ch of ans.toUpperCase()) {
        const idx = 'ABCD'.indexOf(ch);
        if (idx > -1 && lis[idx]) lis[idx].click();
        else console.log(`⚠️ 第${no}题：选项 ${ch} 不存在`);
      }
    } else if (Array.isArray(ans)) {
      // —— 填空（UEditor 富文本） ——
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // SQL 答案的 <、>、& 必须转义，否则被当标签吞掉
      const insts = window.UE && window.UE.instants
        ? Object.values(window.UE.instants).filter(e => tm.contains(e.iframe))
        : [];
      // 编辑器按页面出现顺序对应第 1..n 空
      insts.sort((a, b) => (a.iframe.compareDocumentPosition(b.iframe) & 4) ? -1 : 1);
      if (!insts.length) return console.log(`⚠️ 第${no}题：未找到 UEditor 实例`);
      insts.forEach((ed, n) => {
        ed.setContent(esc(ans[n] ?? ''));
        try { ed.sync(); } catch (e) { /* 旧版无 sync */ }
      });
    }
  });

  // —— 校验输出 ——
  console.log('== 作答结果校验 ==');
  timus.forEach((tm, i) => {
    const lis = [...tm.querySelectorAll('li')].filter(isChoiceLi);
    const got = checkedOf(lis);
    const blanks = [...tm.querySelectorAll('textarea')].filter(t => /^answerEditor/.test(t.id)).length;
    // 多选答案顺序无关（"ADB" 与 "ABD" 等价），排序后比对
    const norm = s => [...s.toUpperCase()].sort().join('');
    const expected = typeof ANSWERS[i + 1] === 'string' ? ANSWERS[i + 1] : '';
    if (got) console.log(`第${i + 1}题 已选: ${got}  ${norm(expected) === norm(got) ? '✓' : '（注意核对）'}`);
    else if (blanks) console.log(`第${i + 1}题 填空×${blanks}（请目检编辑器内容）`);
  });
  console.log('\n✅ 脚本执行完毕。务必截图目检所有高亮选项内容无误后，再运行 3-submit-work.js');
})();
