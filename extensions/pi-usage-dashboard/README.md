# pi-usage-dashboard

`/usage-dashboard` — 扫描本机**全部** pi 会话，生成一个自包含的用量仪表盘 HTML 并在浏览器打开。

按需运行：不后台采集、不起服务、不发任何网络请求。想看的时候跑一次，数据就是那一刻的快照。

## 用法

```
/usage-dashboard            扫描 → 生成 → 用默认浏览器打开
/usage-dashboard no-open    只生成，不开浏览器
```

产物：`<agentDir>/usage-dashboard/index.html`（默认 `~/.pi/agent/usage-dashboard/index.html`，尊重 `PI_CODING_AGENT_DIR`）。

## 数据来源

递归扫描 `<agentDir>/sessions/**/*.jsonl`（含子代理的 `run-0/session.jsonl`），提取 assistant 消息的 `usage` 字段，按 `provider|model|timestamp|totalTokens` 去重（分支副本和嵌套运行副本会重复同一条消息）。

注意：主会话文件的时间戳是 ISO 字符串，嵌套子会话是 epoch 毫秒数字，两者都要接受。

## 订阅额度联动

命令执行时会先调 pi-quota 的 `fetchAllQuotaSnapshots(ctx.modelRegistry)`，把每个 provider 的实时剩余额度内联进 HTML：

- 每个 provider 一张卡：状态灯（健康 / 不合格 / 未知 / 余额）+ 各时间窗剩余百分比条 + 重置倒计时；**余额型 provider**（如 DeepSeek）显示货币余额与可否用，不假装成额度窗口
- provider 名字前面带**品牌 logo**（内联 SVG，离线可用），额度卡片、折叠摘要、供应商-模型表、请求日志四处都有；provider id 形态不一（`openai-codex` / `ollama-copy` / `cc-switch-deep-seek` / `zai-coding-cn`），按去符号后的 id 模糊匹配。Z.AI 的「Z」取自 pi-web 的 `provider-icons.svg`（@lobehub/icons，MIT），其余来自 Simple Icons / Iconify `thesvg`
- 整个区块**可折叠**：标题旁的「收起 / 展开」按钮，折叠后只留一行紧凑摘要（`ollama 73% · ollama-copy 89% · deepseek CNY 730.39 · …`），选择会记住
- 卡片列数**按容器宽度自适应且保持均衡**：先算最多能放几列，再挑一个不留残行的列数（6 个 provider 在宽屏是 3+3，而不是 auto-fit 的 4+2；窄屏变 2×3）
- 额度条按 pi-quota 的策略着色：≤10% 红（不合格）、<40% 黄、其余绿
- 每张卡底部把**本机记录消耗**（成本 / token / 次数，受顶部筛选联动）和**剩余额度**并排放——「花了多少 + 还剩多少」一屏看完
- 两个订阅（如 `ollama` 与 `ollama-copy`）会**各自独立**查额度，因为 pi-quota 按 providerId 取 key
- 抓取失败或没有适配器的 provider 显示「未知 / 未返回额度窗口」，不影响其余内容；standalone `node` 运行（无 registry）时整块隐藏

重置倒计时：pi-quota 的 `QuotaRow` 现在同时带 `reset`（展示用字符串）与 `resetAt`（权威 epoch ms），快照直接读 `resetAt`，不再把展示字符串反解析回时间。不返回重置时间的 provider 只显示剩余百分比；若 `resetAt` 不合理（过去超过 1 小时或未来超过 400 天），仪表盘宁可不显示也不显示错的。

## 仪表盘内容

- **统计带**：累计 Token 数 / Token 使用峰值 / 最长任务用时 / 最长连续天数 / 当前连续天数
  - 「最长任务用时」按 30 分钟空闲切分任务段，取最长的一段（不是会话首尾跨度）
- **KPI 卡**：fresh token、成本、请求数、缓存命中率、缓存节省（粗估）、平均每次请求
- **使用趋势**：指标（Token / 成本 / 请求数）× 分组（总计 / 按供应商 / 按模型 / 按项目），hover 十字线
- **Token 活动**：52 周热力图，三种视角（每天 / 每周 / 累计总量），hover 显示中文日期 + `X万 tokens · N 轮消息`
- **按模型占比** / **成本洞察** / **供应商-模型表**（可展开）/ **请求日志**（可筛选）
- 全部视图受顶部「时间段 + 项目」筛选联动

## 实现约束

- 模板 `template.html` 是纯手写 HTML/CSS/SVG，**零依赖、零 CDN**；记录集以 JSON 内联（转义 `<`，避免名字里有 `</script>` 时逃逸）
- `build.ts` 可被 `node` 直接 import（不依赖 pi 运行时），便于独立验证数字
- 打开浏览器用 `cmd /c start` / `open` / `xdg-open`，不经过 shell 拼接

## 验证

```bash
node -e "const m=await import('./build.ts'); console.log((await m.generateUsageDashboard()).stats)"
```

### 不用 pi 也能渲染额度区块

`generateUsageDashboard` 接受 `quota` 选项，喂样例额度就能把「订阅额度」整块渲染出来，`node` 直接跑、不需要 pi 运行时：

```js
// preview.mjs —— 改配色 / 列数 / 折叠态 / provider logo 时用，比跑真额度快
const m = await import("./build.ts");
await m.generateUsageDashboard({
  outDir: "./dash-preview", // 别省略：默认 outDir 会覆盖 <agentDir>/usage-dashboard/index.html
  quota: [
    { provider: "openai-codex", status: "HEALTHY", tightestRemainingPct: 62,
      windows: [{ label: "5h", remainingPct: 62, usedPct: 38, resetAt: Date.now() + 3 * 3600e3 }] },
    { provider: "deepseek-official", status: "UNKNOWN", windows: [],
      balances: [{ currency: "CNY", amount: "42.10", available: true }] },
  ],
});
```

渲染后截图确认（本机浏览器工具是 `agent-browser`，支持 `file://`，输出要重定向，否则守护进程占住管道）：

```bash
agent-browser open "file:///$(pwd)/dash-preview/index.html" </dev/null
agent-browser screenshot shot.png </dev/null
agent-browser close </dev/null
```
