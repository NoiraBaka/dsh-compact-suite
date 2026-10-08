# dsh-compact-suite

给 DSH 的上下文压缩加一块面板。管四件事：

**什么时候压 · 用哪个模型摘要 · 按什么口径算 token · 怎么关掉**

---

## 30 秒概览

| 你会遇到的问题 | 这个插件做什么 |
| --- | --- |
| 阈值滑块往上拖，压缩还是提前触发 | 覆盖引擎的阈值公式，让**滑块比例成为唯一决定因素** |
| 一次压缩要等好几分钟（本地模型） | 把压缩那一次调用**改派到指定 provider/model** |
| 卡片才 40%，压缩已经在跑 | 把引擎的 token 口径**换成卡片的那一份** |
| 停用插件后行为没变回来 | 停用即**还原引擎**，不重启进程 |

装：`npm pack` 后在「设置 → 插件 → 安装」里选那个 `.tgz`。

**不用卸载就能开关**：面板顶部的「接管压缩阈值」关了就等于还原。

---

## 安装

```bash
git clone https://github.com/NoiraBaka/dsh-compact-suite.git
cd dsh-compact-suite
npm test      # 三套回归夹具
npm pack      # 得到 dsh-compact-suite-<版本>.tgz
```

在 DSH 的「设置 → 插件 → 安装」里选这个 `.tgz`，或让 agent 用插件管理器指向它的绝对路径。

**必须用 tarball，不要用 `link:`。** 插件要 import `@deepseek-ai/schemastery`，符号链接会让 Node
沿真实路径向上查找，找不到宿主包。

依赖：宿主侧只有 Node 内置模块 + `@deepseek-ai/schemastery`；客户端只有 `react` +
`@deepseek-ai/dsh-client-ui-primitives`。

---

## 面板有哪几块

位置：输入框左侧工具行，和【技能】同一排。

| 控件 | 做什么 |
| --- | --- |
| **接管压缩阈值** | 总开关。关掉 = 还原所有引擎 |
| **摘要模型** | 「跟随会话模型」或指定 provider/model |
| **触发阈值** | 滑块。两种模式下都能拖 |
| **保留量** | 归谁管：自动 / 手动。切到手动后出现「保留方式」三个按钮 |
| **接管状态** | 引擎接管结果，五种之一 |
| **压缩记录** | 本会话每次压缩。默认折叠，每 5 秒刷新 |
| **立即压缩** | 不等阈值，马上压一次 |

### 接管状态的五种说法

`已接管 N/M 个压缩引擎` · `只接管了 N/M 个压缩引擎，其余没有接受改写` ·
`找到 M 个压缩引擎，但没有任何一个接受改写` · `已暂停：M 个引擎已还原成原样` ·
`未找到压缩引擎`

### 记录的三种触发原因

| 标记 | 含义 |
| --- | --- |
| `手动` | 你点了「立即压缩」 |
| `压力` | 达到阈值，引擎自动触发 |
| `溢出` | provider 拒绝了请求。**出现它就说明路由配置的 `contextWindow` 大于该端点实际接受的量**，该改的是路由，不是阈值 |

### 显示约定

- 时间按本机时区显示成 `MM-DD HH:MM`。
- 记录是固定列网格，换数字位数不会错位。
- 失败的压缩单独成行、标红、原样显示错误文本。
- `after` 未知时显示 `—`，节省量一栏留空（原因见「记录里的数字」）。
- 本地 provider 把 model 报成权重文件路径时，只显示文件名，完整值在 tooltip。
- 窗口未知时显示「本会话的模型窗口还未知 —— 发一条消息后自动算」，滑块仍可拖。

---

## 触发点怎么算

```
实际触发点 = max(滑块比例 × 窗口, 下限 × 窗口)
```

面板会把这两个数分别写出来，并注明生效的是哪一个。

自动模式下的保留量：

```
保留量 = clamp(round(触发点 × 2%), 1000, 32000)
```

默认 80% 时的换算：

| 窗口 | 触发点 | 保留量 | 滑块下限 |
| --- | --- | --- | --- |
| 16K | 13.1K | 1.0K | 12.4% |
| 32K | 26.2K | 1.0K | 6.2% |
| 128K | 104.9K | 2.1K | 5% |
| 256K | 209.7K | 4.2K | 5% |
| 1M | 838.9K | 16.8K | 5% |

### 为什么会有「下限」

引擎的硬约束是 `retainTokens < thresholdTokens`。不满足时引擎**每次判定都抛错**，自动压缩随之失效，
而且只在第一次警告。所以每条下发路径都会把比例垫高：

```
有绝对保留量时：下限 = clamp((保留量 + 1024) / 窗口, 5%, 95%)
否则：          下限 = max(20%, 存下来的保留比例 + 1%, 引擎当前携带的比例)
```

引擎当前携带的比例也要看，因为它可能由其他管理器写入。垫高后面板报出的是**实际生效**的比例。

### 手动模式：保留量怎么写

| 方式 | 写入 | 效果 |
| --- | --- | --- |
| **默认** | 两个字段都清掉 | 交回引擎自带的 16% 比例 |
| **比例** | `retainRatio` | 引擎原生字段，绝对值随窗口放大 |
| **绝对值** | `retainTokens` | 固定值，与窗口无关 |

切到手动时会用**自动当时正在用的值**填入，而不是你之前手打过的旧值。三个按钮都立刻写入并落盘。

面板还会报出**压不动的头部**（系统提示的实测价格，引擎不会压缩它）和 `压缩后下限 = 头部 + 保留量`。

---

## 它靠什么做到

### 1. 摘要改派：拦 `llm/stream`

在 `llm/stream` 这个 waterfall 接缝上，把 `purpose === 'compaction'` 的那一次调用改派到指定
provider/model。

不走引擎自带的 `summarizationProvider` / `summarizationModel`：那两个键必须配在 `compaction-basic`
自己那一行，而它位于 agent preset 的 `isolate` 组内，既不属于 profile 根，也没有设置界面。

好处：本插件以**顶层行**身份即可生效，且**与挂的是哪个压缩引擎无关**。

### 2. 阈值：抵消掉公式的第二项

引擎的触发条件：

```
thresholdTokens = floor(min(contextWindow × thresholdRatio,
                            contextWindow − reservedCompletionTokens − headroomTokens))
```

第二项常常更小，于是滑块失效。例如 `W=200000, O=128000, headroom=65536` → 阈值恒为 72000（36%）。

本插件把每个引擎的 `headroomTokens` 设为 `-1000000`，第二项恒大于第一项，`thresholdRatio`
成为唯一决定因素。这是**抵消**，不是预算。`maxTokens` 另行保留。

代价：负值绕过了 schema 校验，所以启动时会自检一次归属标记，读不到就在日志里告警「接管未生效」。

### 3. token 口径：换成卡片的那一份

DSH 有两套口径：

| | 算法 |
| --- | --- |
| 卡片 | `contextPressure` 投影，主项是 provider 回报的真实 prompt usage |
| 引擎 | `TokenMeter.measure().totalTokens`，真实 usage 与 **4 字符/令牌**启发式**取高者** |

中英文与代码实际约 5.4–6.9 字符/令牌，启发式写死 4，所以几乎总是高估 33%–73%，而「取高者」
让它永远生效。

插件包装 `meter.measure`，只替换 `totalTokens`；`nodes` 原样透传（压缩选区校验只读 `nodes`）。

### 4. 引擎发现：绕过 `isolate`

遍历 `ctx.registry` 里每个 fiber 的 `store.compaction`。

`isolate` 只拦上下文代理的取值，fiber 自己的 `store` 是普通对象。引擎每次判定都重新读
`this.config`，所以替换实例上的 config 即可，不用重新挂载。

### 5. 立即压缩：走 `/compact` 命令

不直接调用 `compaction.compactNow`，而是执行本 composition 的 `/compact` 命令。三个理由：

- `compaction` 缝被 `isolate` 在 agent preset 组内，根层解析不到实例；`commands` 不在 isolate 名单里。
- `dsh-command-compact` 已经把各类失败（`busy` / `cancelled` / `changed` / `summary` / `commit` /
  `persistence`）归并成可读文案。
- 这次调用会作为 `command/run` 写进会话日志，所以按按钮和手打 `/compact` 一样可追溯。

命令结果只有英文，面板对四种已知形态做了本地化（两种成功、`busy`、`cancelled`），其余原样透出。

`busy` 最常见：按钮只知道「有没有压缩在跑」，不知道 agent 是否正在回合中。引擎自己也会拒绝第二次压缩，
插件在入口处直接拒掉，避免双击的第二次请求等上几分钟。

### 6. 可逆

| 机制 | 做法 |
| --- | --- |
| 停用/卸载 | disposer 调 `restoreEngines()` 换回捕获的 config，`unpatchMeters()` 拆掉包装 |
| 「暂停」的定义 | 所有生效路径都经 `applySwitch()`：接管 = 改引擎 + 包 meter + 装输出兜底；暂停 = 三者全撤 |
| 认领标记 | 每次改写都写 `Symbol.for("dsh-compact-suite.owned")`，供其他插件辨认 |
| 拒收别人的值 | 没有本插件标记却已是负 headroom 的 config 只可能是别的插件写的，**跳过并告警**，不当成「原值」保存 |

---

## 记录里的数字

`$DSH_HOME/compaction-log.json`，最多 200 条。

- **模型字段写的是真正执行的那一个。** 引擎在把请求交给 `llm.stream()` **之前**就把它解析的 target
  写进了事件，而插件是在 waterfall **内部**改写的。插件是唯一知道请求实际发给谁的一方，所以自己记录；
  引擎的说法保留在接口的 `engineModel` / `engineProvider` 里，不一致时可对照。
- **`after` 只在拿到用量采样之后才写。** `compaction/end` 时替换体已追加，但 provider 还没为新表面
  回报用量，此时 meter 的投影仍带着压缩前的 surface 戳，不是有效测量。所以这一刻不写 `after`，
  由下一个用量采样结清；在此之前面板显示 `—`。记录本身在压缩结束时即出现。
- **安装之前的压缩会被补录。** 三个压缩事件是持久化的，插件回放会话日志补进记录（标记 `historical`），
  按 `compactionId` 去重。补录遵守同一条 `after` 规则。

---

## 配置与文件

写在插件行上（顶层同 id 行 → 设置页可改）。**只是首次运行的初始值**，之后以面板为准。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `summarizationProvider` | `deepseek-account` | 摘要 provider |
| `summarizationModel` | `deepseek-flash` | 摘要 model |
| `thresholdRatio` | `0.8` | 初始触发比例 |

两个 `summarization*` 留空 = 跟随会话模型。

配置必须写在**顶层同 id 行**，不能放进 `insert` 块内部 —— `insert` 块内的行无法被 configEditor
唯一定位，设置页写入会被 compose 自检拒绝。

| 文件 | 内容 |
| --- | --- |
| `$DSH_HOME/compact-suite.json` | 面板当前设置，优先于配置里的 `thresholdRatio`。带版本号 |
| `$DSH_HOME/compaction-log.json` | 压缩记录 |

### HTTP 接口

| 路由 | 说明 |
| --- | --- |
| `GET /compact-suite/api/state?session=<id>` | 阈值、开关、路由、provider 列表、`contextWindow`、`thresholdTokens`、`ratioIsBinding`、`ownedEngines`、`headroomTokens`、`triggerBoundBy` |
| `POST /compact-suite/api/state` | `{thresholdRatio?, summarizationProvider?, summarizationModel?, enabled?, auto?, retainRatio?, retainTokens?}`。`retainRatio` 与 `retainTokens` 互斥且必须低于触发比例，否则 400；`null` = 回到引擎默认。写入手动值会自动退出 `auto`。全部字段先校验完再一次性提交 |
| `GET /compact-suite/api/log?session=<id>` | 压缩记录，新的在前 |
| `POST /compact-suite/api/compact?session=<id>` | 立即压缩，返回 `{commandId, kind, text}` |
| `GET /compact-suite/api/models?provider=<p>` | 列出该 provider 的模型 |

---

## 限制与兼容

### 已知限制

- **依赖上游内部结构**：引擎发现靠 `fiber.store.compaction`，阈值覆盖靠替换已解析的 `config`。
  上游改形状后可能失效 —— 启动自检会告警，不会静默失败。
- 只改**已挂载**的引擎实例，磁盘上 `compaction-basic` 的默认值不受影响。
- 摘要路由依赖 `llm.stream` 的 waterfall 语义。宿主若改成不可拦截，路由失效（压缩仍可用，回落会话模型）。
- **输出兜底是启发式的**：拦截 `max_completion_tokens ≤ 16384` 的请求并抬高上限。已知会影响
  `session-title-llm` 的 64（无害，它是上限不是配额）。接口以 `outputRescue` 报告状态。
- 面板的 `窗口 · 滑块上限` 需要本会话发过一次请求；此前显示「还未知」。
- **压不动的头部只能实测**，同样需要先有一条消息走过；此前显示「还未知」，不填 0。
- **「立即压缩」要求 agent 空闲**，否则命令返回 `busy`。
- 只在 DSH `0.2.0-rc.2` + Windows 上实机验证。

### 兼容性

**不建议和 `dsh-compaction-threshold` 同时启用。** 两者改写同一批引擎的 `config`。共存不会互相污染
（没有本插件标记却已是负 headroom 的 config 一律跳过），代价是那批引擎不受本插件滑块控制，
日志里会留下跳过数量的告警。

**不要和 `@dsh-plugin/dsh-auxiliary` 的压缩模型路由同时启用。** 两者都拦 `llm/stream` 改写压缩目标，
同时开启时以先注册者为准，结果不确定。

| 能力 | `dsh-compaction-threshold` 1.0.3 | 本插件 |
| --- | --- | --- |
| 覆盖触发阈值 | ✅ | ✅ |
| 摘要改走指定模型 | — | ✅（写在 `llm` 接缝上，与引擎无关） |
| 暂停/卸载后还原引擎 | ❌ 不保存原值 | ✅ |
| 压缩记录带 provider/model | — | ✅ |
| 补录安装前的压缩历史 | — | ✅ |
| 图形界面 | — | ✅ |

---

## 开发与测试

`npm test` 跑三个夹具。它们不复制逻辑，而是从 `lib/index.js` 里按名字抽出真正会被发布的函数，
放进独立的 `new Function` 作用域执行 —— 断言的对象就是真实代码。

| 夹具 | 覆盖 | 可指向旧源码 |
| --- | --- | --- |
| `test/render-panel.mjs` | 9 个渲染场景、90 个回调、滑块实时重算。挡「渲染期抛错导致槽位永久退役」和「事件回调抛错」 | — |
| `test/host-policy.mjs` | 穷举 150 组「窗口 × 比例 × 模式」，断言**保留量永远留在阈值之下** | `node test/host-policy.mjs <旧文件>` |
| `test/log-after.mjs` | 假 `TokenMeter` + 真实落盘，断言接口输出与磁盘内容 | `node test/log-after.mjs <旧文件>` |

### 实现要点

- 浏览器半区走公开插槽 `conversation.input.left`，不做 DOM 增强。
- 主题用宿主导出的 `--dsw-alias-*` 变量；`prefers-reduced-transparency` / `prefers-reduced-motion`
  下退回不透明样式。
- 与相邻的【技能】chip 对齐：32px 高、`1px solid var(--dsw-alias-border-l2)`、`.12s` 过渡。
- 弹层用宿主的 `useAnchoredPosition`，不写死偏移。
- 文案走 `ctx.locale` 的 zh/en 字典。

---

## 归属

MIT。

阈值公式的覆盖方式与 `headroomTokens: -1e6` 这一抵消手法源自
[`dsh-compaction-threshold`](https://www.npmjs.com/package/dsh-compaction-threshold) 1.0.3（MIT）。
摘要路由的接缝选择参考 `@dsh-plugin/dsh-auxiliary` 的 `compact-router`，按其思路独立重写，未复制其代码。
