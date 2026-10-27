'use strict';

/**
 * 视觉确认脚本：渲染真实界面并截图到 test/shots/。
 *
 * 为什么单独一个脚本：功能测试全绿 ≠ 界面是对的。
 * 上一轮就出现过「CSP 漏了 style-src 'self'」—— DOM 文本完全正确、测试全绿，
 * 但整页没样式。只靠截图才能看出来。
 *
 * 跑法：npm run shot
 */
const path = require('path');
const fs = require('fs');

const candidates = [
  'playwright',
  'D:/node/node_modules/playwright',
  'D:/node/node_modules/@playwright/cli/node_modules/playwright',
];
let electron = null;
for (const c of candidates) {
  try {
    electron = require(c)._electron;
    break;
  } catch {
    /* 试下一个 */
  }
}
if (!electron) {
  console.error('找不到 playwright —— npm i -D playwright 或用全局的 @playwright/cli');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [ROOT],
  });
  const winOf = async (n) => {
    for (let i = 0; i < 40; i++) {
      await wait(250);
      const w = app.windows().find((x) => x.url().includes(n));
      if (w) return w;
    }
    return null;
  };

  const ball = await winOf('ball.html');
  if (!ball) throw new Error('圆球没起来');
  await wait(1500);

  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(90);
  await ball.mouse.up();
  await wait(1200);

  const panel = await winOf('panel.html');
  if (!panel) throw new Error('面板没展开');

  // 清单视图：塞几条有代表性的数据
  await panel.evaluate(() => localStorage.removeItem('ai-dashboard.todos.v1'));
  await panel.reload();
  await wait(900);
  for (const t of ['给房东回消息确认续租', '买咖啡豆（浅烘）', '整理上季度的报销单', '给项目组写周报']) {
    await panel.fill('#todo-input', t);
    await panel.press('#todo-input', 'Enter');
  }
  await wait(300);
  await panel.click('.todo-item:nth-child(3) .todo-check');
  await wait(1800); // capturePage 会滞后一帧，等合成帧稳定
  await panel.screenshot({ path: path.join(OUT, 'todo.png') });

  // AI 监控视图
  await panel.click('.tab[data-view="ai"]');
  await wait(1800);
  await panel.screenshot({ path: path.join(OUT, 'ai.png') });

  await ball.screenshot({ path: path.join(OUT, 'ball.png') });

  await app.close();
  console.log(`✓ 截图已存到 ${OUT}`);
})().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
