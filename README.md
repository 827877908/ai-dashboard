# 个人效率工作台（ai-dashboard）

桌面角落一个半透明小圆球。**点开是「我的清单」，切个 Tab 是「AI 监控」。**

不是网页，不开黑框框，不抢你正在打的字。

```
   ┌────────────────────────────────┐
   │ ●  我的清单            3 件待办 │  ← 默认视图：你自己的事
   ├────────────────────────────────┤
   │  我的清单 ③ │ AI 监控           │
   ├────────────────────────────────┤
   │ [ 添加一件事…            ] ＋  │
   │  还剩 3 件          清除已完成   │
   │  ○ 给项目组写周报              │
   │  ○ 整理上季度的报销单       ✕  │
   │  ✓ 买咖啡豆（浅烘）            │  ← 打勾 = 划横线
   └────────────────────────────────┘
```

## 跑起来

```bash
cd D:/codex_Files/ai-dashboard
npm start
```

退出：系统托盘图标 → 退出。

## 三个交互

| 动作 | 结果 |
|---|---|
| **短按**球 | 展开面板（面板贴着你放球的那个角落出现） |
| **长按**球（≥320ms） | 进入拖拽，跟着手指走；松手停在原地，下次启动还在那 |
| 点面板**外部** | 面板失焦自动收起 |

长按才拖是为了不和点击抢手势 —— 球就 48×48，短按即拖会让「点开面板」变得不可靠。

## 单实例

**再开一个不会分裂你的清单。** 应用带单实例锁：第二个实例立刻退出，
并把「要看哪个 status.json」交给已有实例（已有实例换数据源 + 把面板叫出来）。

不这么做的话，两个实例共用一个 userData 目录会互相抢缓存目录（日志里刷 `Unable to move the cache`），
而且 localStorage 会被拆成两份 —— 清单一半在这边一半在那边。

测试用独立 userData（免得跟运行中的实例抢）：

```bash
AI_DASHBOARD_USER_DATA=D:/tmp/ai-dashboard-test npm start
```

## 两套状态，物理隔离

```
我的清单                          AI 监控
├─ 本地持久化状态                 ├─ 外部只读投影
├─ localStorage（ai-dashboard.todos.v1）   └─ status.json（编排器写，本面板只读）
├─ AI 没跑也能用                  ├─ 清单坏了也照样显示
└─ 刷��不丢、关掉重开还在
```

**AI 监控那半边的数据来自** `D:/codex_Files/orchestrator/plans/status.json`，
由编排器的 `src/observability.ts` 实时写入。要看别的 run：

```bash
AI_DASHBOARD_STATUS=D:/other/plans/status.json npm start
npm start -- --status=D:/other/plans/status.json
```

### status.json 契约

```jsonc
{
  "version": 1,
  "runId": "da95b5b2",          // 想法的 FNV-1a 哈希，同想法可复现
  "idea": "把想法拆成任务…",
  "state": "running",           // running | done | error | interrupted
  "phase": "executing",
  "startedAt": "2026-10-27T15:51:02.886Z",
  "updatedAt": "2026-10-27T15:51:02.894Z",   // 心跳
  "finishedAt": null,
  "totals": {
    "total": 6, "pending": 2, "running": 2,
    "done": 1, "failed": 1, "skipped": 0,
    "costUsd": 1.81
  },
  "tasks": [
    {
      "id": "t1", "title": "实现登录页", "kind": "implement",
      "status": "running",        // pending | running | done | failed | skipped
      "attempts": 1,              // 重试了几次
      "durationMs": 84000, "costUsd": 0.31, "error": null,
      "startedAt": "…", "finishedAt": null
    }
  ]
}
```

- 编排器没跑 → 显示「等待编排器…」
- 编排器崩了 → 超过 10 秒心跳没更新就显示「连接中断」（靠心跳判定，不靠编排器优雅收口）

## 目录

```
src/
  main.js          主进程：窗口、拖拽坐标解耦、每秒轮询、托盘
  preload.js       contextBridge，渲染层能碰的只有这几个函数
  renderer/
    ball.html/js   圆球：长按拖拽 / 短按展开 / 状态灯
    panel.html/js  面板：Tab 切换 + 个人清单 + AI 监控
    style.css      深色玻璃卡片
scripts/
  start.js         启动器（不依赖 node_modules/.bin，见下）
```

## ⚠️ 关于 electron 怎么装的

这台机器上 `npm install electron` **装不上** —— 二进制从 GitHub release 下载会被断流
（`ECONNRESET`）。所以 `node_modules/electron` 是**从 `zhouzhou-mini`（桌宠项目）复制**
的现成运行时（Electron 33.0.0），连 `.bin` 软链都没有。

因此 `npm start` 走 `scripts/start.js`（直接 `require('electron')` 拿 exe 路径），
而不是 `electron .`。以后在能联网的机器上正常 `npm install` 之后照样能跑。

## 已知边界

- **多屏坐标**：球可以拖到任意一块屏；位置恢复会收敛到所有显示器的并集范围（不会丢）。
  面板永远贴着球所在那块屏出现。
- 圆球那 48×48 会吃掉自己的点击区（Windows 上点击穿透有已知坑，没做）。
- 只监控**编排器**的进度。要看别的 agent 框架，得另写一个生产者写同样格式的 status.json。
- 没做打包（electron-builder）。要打成 exe 得先解决 electron 二进制下载的问题。
