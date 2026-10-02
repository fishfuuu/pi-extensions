# pi-ollama-cloud-copy

用**第二个 Ollama Cloud 订阅**：注册两个 provider 指向同一个 Ollama Cloud API（`https://ollama.com/v1`），于是两份 Pro 订阅可以同时跑。

| provider id | 凭证（`auth.json` 条目） | 订阅 |
|---|---|---|
| `ollama` | `ollama` | #1 |
| `ollama-copy` | `ollama-copy` | #2 |

模型目录（内置兜底 + 实时刷新 + thinking 档位映射 + 上下文窗口 + 价格）**复用已安装的 `pi-ollama-cloud` npm 包**，不在本扩展里重复一份。它同时（重新）注册 `ollama`，让两个 provider 共享同一份模型目录定义。

## 依赖

必须先装上游包；否则本扩展只打一条日志、不注册任何 provider：

```
pi install npm:pi-ollama-cloud
```

## 凭证

本扩展**不接触 API key**：pi 按正常 auth 链解析每个 provider 的凭证——先看 `auth.json` 里以 provider id 命名的条目，再回落到 `apiKey` 里写的环境变量：

- `ollama` → `$OLLAMA_API_KEY`
- `ollama-copy` → `$OLLAMA_COPY_API_KEY`

## 可选

不在默认安装包里（只有开了第二订阅的人才需要）：

```powershell
.\scripts\install.ps1 pi-ollama-cloud-copy
```

如果上游 `pi-ollama-cloud` 将来自己支持多订阅，这个扩展就可以删掉了。
