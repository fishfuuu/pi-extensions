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

## 仪表盘内容

- **统计带**：累计 Token 数 / Token 使用峰值 / 最长任务用时 / 最长连续天数 / 当前连续天数
  - 「最长任务用时」按 30 分钟空闲切分任务段，取最长的一段（不是会话首尾跨度）
- **KPI 卡**：fresh token、成本、请求数、缓存命中率、缓存节省（粗估）、平均每次请求
- **使用趋势**：指标（Token / 成本 / 请求数）× 分组（总计 / 按供应商 / 按模型），hover 十字线
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
