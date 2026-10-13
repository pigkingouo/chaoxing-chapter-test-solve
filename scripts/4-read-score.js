// ============================================================
// 4-read-score.js
// 用法：在提交后跳转到的"查看已批阅作业"结果页（selectWorkQuestionYiPiYue）
//       的控制台运行，读取成绩与重做信息。
// （提交脚本 3 所在的页面上下文会随整页跳转销毁，所以读分必须单独跑。）
// ============================================================
(() => {
  const t = document.body.innerText.replace(/\s+/g, ' ');

  const score = t.match(/最终成绩[\d.]+分/) || t.match(/本次成绩[\d.]+分/);
  console.log(score ? '🎯 ' + score[0] : '⚠️ 未读到成绩——当前页面可能不是结果页（URL 应含 selectWorkQuestionYiPiYue）');

  const redo = t.match(/重做[^章]{0,12}/);
  console.log(redo ? '🔁 可重做: ' + redo[0].trim() : '🔁 无重做入口（当前成绩为最终成绩）');

  // 逐题得分速览：题号 + 我的答案 + 得分
  const re = /(\d+)\s*【[^】]+\】([\s\S]{0,200}?)我的答案[：:]\s*([\s\S]{0,40}?)\s*(\d+(?:\.\d+)?)分/g;
  const rows = [];
  let m;
  while ((m = re.exec(t)) !== null && rows.length < 20) {
    rows.push(`第${m[1]}题 得${m[4]}分`);
  }
  if (rows.length) console.log('== 逐题得分 ==\n' + rows.join('\n'));

  console.log('\n提示：若需重做冲分，点击页面上的"重做"链接后，在新的答题页重新运行 2-answer-work.js');
})();
