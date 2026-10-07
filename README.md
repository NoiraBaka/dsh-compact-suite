# dsh-compact-suite

**给本地部署的 DSH 一个上下文压缩控制面。**

DSH 自带的自动压缩，把「什么时候压、用哪个模型压、按什么口径算、怎么关掉」四件事都固定在
`@deepseek-ai/dsh-compaction-basic` 里。跑本地模型时，这四件事恰好都最难受：

| 现象 | 原因 |
| --- | --- |
| 阈值滑块拖到 36% 以上毫无反应 | 真正生效的是 `窗口 − 预留输出 − 65536` 这一项，实测压缩在 **72196** 和 **88293** 令牌就触发了，而不是滑块写的 160000 |
| 一次压缩好几分钟 | 摘要走当前会话模型 —— 本地卡要为整段上下文重算一次 prefill，这是本地部署里最贵的一次调用 |
| 卡片才 40%，压缩已经在跑 | 卡片和引擎用的不是同一个 token 口径，两者差 33% ~ 72% |
| 关不干净 | 改写的是引擎实例的内存对象，停用后改动留在进程里，重启前一直生效 |

本插件把这四件事变成可以随时改、随时关、关了不留痕的东西，并给出一块常驻输入框的「压缩」面板。

> 状态：`2.5.0`，在 DSH `0.2.0-rc.2`（desktop / Windows）上实机验证。接管依赖上游内部结构，
> 见「已知限制」。

---

## 面板里有什么

常驻在输入框左侧工具行（和技能面板同一排）：

| 区域 | 作用 |
| --- | --- |
| **接管压缩阈值** | 总开关。关掉即把所有被改过的引擎**还原成原样**，不用卸载插件 |
| **摘要模型** | 「跟随会话模型」或指定 provider/model —— 压缩那一次调用改派到云端 |
| **触发阈值** | 滑块 + `窗口 256K → 触发于 205K` 的换算。比例不是决策单位，token 才是 |
| **状态行** | 如实分成五种：`已接管 N/M 个` / `只接管 N/M 个` / `找到 M 个但都没接受改写` / `已暂停：M 个已还原` / `未找到压缩引擎` |
| **压缩记录** | 本会话每次压缩：时间、前后 token、省下多少、以及**这次摘要是哪个模型跑的**；打开时每 5 秒刷新，标题栏可折叠 |
| **立即压缩** | 压缩记录标题栏右侧的按钮。不等阈值，马上压一次，结果就地回显 |

时间戳按本机时区显示成 `MM-DD HH:MM`（记录本身是 UTC ISO 串，原样打出来会占掉整行），
并且整格不可收缩 —— 否则模型名一长，`10-07 21:06` 会从中间的空格断开成两行。
**失败的压缩单独成行**：`compaction/end` 带 `error` 的记录不是「省下 0 令牌」，
而是一次没有完成的压缩，面板把它标红并原样转出错误文本，而不是让它混在成功的记录里。
**`after` 未知时显示 `—`**：`TokenMeter` 被包装成回报卡片的 `contextPressure`，而这个投影在
provider 再次回报用量之前仍带着压缩前的 surface 戳，会**塌向零**。刚压完 318K 的会话不可能是空的，
所以 `318K → 0` 不是读数而是这个塌陷——它在落盘前就被丢掉，读取旧记录时也一并修正。留着它不只是
难看：它宣称整个上下文被清空，读者会以为还有大把余量，**方向是危险的**。
本地 provider 报的 model 是这个权重文件的**绝对路径**（比整行还宽），面板只显示文件名，
完整值留在 tooltip 里；`org/model` 这种 id 不做截断。

面板用宿主自己的菜单材质 token（`--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter`），
跟随浅色/深色主题；`prefers-reduced-transparency` 与 `prefers-reduced-motion` 下自动退回不透明样式。

### 立即压缩怎么实现的

按钮把请求交给**本 composition 自己的 `/compact` 命令**，而不是直接去够 `compaction.compactNow`：

```js
const agent = ctx.agents.get(sessionId);            // 会话 → agent
await ctx.commands.execute(agent, "/compact", [], signal);
```

三个理由：

1. `compaction` 缝被 `isolate` 在 agent preset 组内，**根层 `ctx.get("compaction")` 解析不到实例**；
   而 `commands` 不在 isolate 名单里，并且按 agent 解析命令（`find(agent, name)`），正好看得见组里
   注册的那个 `/compact`。
2. `dsh-command-compact` 已经把每种预期失败（`busy` / `cancelled` / `changed` / `summary` /
   `commit` / `persistence`）归并成一句人话，也把「没有可压缩历史」单独报出来 —— 重复实现一遍只会
   和官方说法漂移。
3. 这次调用会作为 `command/run` + `command/done` 写进会话日志，所以**按按钮和手打 `/compact`
   在记录里一样可追溯**。

按钮顺带把官方只做了一半的事补齐：`/compact` 的结果文案只有英文，面板按它**四种已知形态**
本地化 —— 两种成功（`No compactable history yet.` / `Compacted N history items (~M tokens).`）
和两种最常撞到的失败（`busy`、`cancelled`）。其余一律原样透出，所以上游改措辞只会退化成英文，
不会变成一句自信的错译。

`busy` 值得单独说：按钮的禁用状态只知道「有没有压缩在跑」，不知道 agent 是否正在回合中，
所以**一轮还没跑完时点按钮就会撞到它**，这是最常见的失败。

并发上，引擎自己会拒绝第二次压缩（报 `busy`），但那样双击的第二次请求要等上几分钟才被告知，
所以插件在入口直接拒掉。`/state` 里带 `compacting` 字段：压缩比面板活得久，重开面板不会把一个
正在跑的活儿显示成空闲。

---

## 四个机制

### 1. 摘要改用指定模型

挂在 `llm/stream` 这个 waterfall 接缝上，把 `purpose === 'compaction'` 的那一次调用改派：

```js
ctx.on('llm/stream', (options, next) => {
  if (options.purpose !== 'compaction') return next();
  const route = routeOf();
  if (route === undefined) return next();
  return ctx.llm.stream({ ...options, provider: route.provider, model: route.model });
}, { global: true });
```

**为什么不用 `compaction-basic` 自带的 `summarizationProvider` / `summarizationModel`**：那两个键必须配在
`compaction-basic` 自己那一行上，而它挂在 agent preset 的 `isolate` 组内 —— 那一行既不属于 profile 根，
也就没有设置界面。改走 llm 接缝后，本插件以**顶层行**身份即可生效，且**与挂的是哪个压缩引擎无关**
（`compaction-basic` / `billion-context` / DCP 都同样被接管）。

`global: true` 用来穿透 realm 过滤：压缩发生在 preset 的子领域里。

### 2. 废掉阈值的容量项

官方触发条件是

```
thresholdTokens = floor(min(contextWindow × thresholdRatio,
                            contextWindow − reservedCompletionTokens − headroomTokens))
```

第二项常常是决定性的：`W=200000, O=128000, headroom=65536` 时阈值只有 **72000（36%）**，
滑块调到多高都是死的。

本插件把每个引擎的 `headroomTokens` 设为 **−1000000**，于是第二项恒大于 `W × ratio`，`ratio` 成为
唯一决定因素。这个量不是预算，是一次**抵消** —— 只要绝对值超过任何真实的 `contextWindow` 就够。
`maxTokens` 另行保留，摘要器自己的输出上限不受影响。

实现上直接替换引擎实例上**已经解析好**的 `config` 对象，从而绕过 schemastery 的校验（负数过不了
原来那条 `>= 0` 的规则）。代价是没法靠 schema 保证生效，所以启动时做一次自检：把归属标记从引擎上
读回来，读不到就在日志里告警「接管未生效」，而不是静默失败。

面板会**如实报告** `ratioIsBinding`；当窗口大到 `W × ratio` 逼近那个 100 万的抵消量时，给出警告
而不是假装正常。

### 3. 引擎口径对齐到卡片

DSH 有两套 token 口径：

| | 算法 |
| --- | --- |
| 卡片 | `contextPressure` 投影，主项是 provider 回报的**真实** prompt usage |
| 引擎 | `TokenMeter.measure().totalTokens`，真实 usage 与 **4 字符/令牌启发式**取高者 |

中英文/代码的实际密度约 5.4–6.9 字符/令牌，启发式硬编码 4，几乎总是**高估 33%–73%**，
且「取高者」让它永远赢。结果是卡片才 50% 出头、引擎已越过 80% 阈值。

本插件包装 `meter.measure`，只把 `totalTokens` 换成卡片的值，`nodes` 原样透传（压缩选区与
surface 稳定性校验只读 `nodes`），带 `requestHeader` 的推测性调用不介入。

### 4. 引擎发现绕过 `isolate`

```js
for (const runtime of ctx.registry.values())
  for (const fiber of runtime.fibers ?? []) {
    const impl = fiber.store?.compaction;
    if (impl?.value !== undefined) found.push(impl.value);
  }
```

`isolate` 只拦上下文代理的取值，fiber 自己的 `store` 是普通对象 —— 所以顶层插件能拿到每个 preset 里的
引擎实例，不需要在 preset 里换行。引擎的 `compactIfNeeded` 每次判定都重新读 `this.config`，
因此替换实例上的 config 即可，不必重新挂载。

---

## 生命周期（不留垃圾）

插件改写的是**别人的**运行时对象，因此必须能收回：

- **停用/卸载时还原**：`ctx.effect` 的 disposer 调 `restoreEngines(ctx)`，把每个引擎的 `config`
  引用换回改写前捕获的那一份；同时 `unpatchMeters()` 拆掉 `measure` 包装，并还原被包装过的
  `globalThis.fetch`。**不重启进程也会干净。**
- **「暂停」有唯一定义**：所有生效路径都经 `applySwitch(ctx)` —— 接管 = 改写引擎 + 包装 meter +
  装输出兜底；暂停 = 三者全部撤除。早期版本里 `agent/pre-step` 会无条件重新接管，导致暂停在下一步
  就被撤销（2.0.1 修复）。
- **认领标记**：每次改写都会在 config 对象上写 `Symbol.for("dsh-compact-suite.owned")`。Symbol 对
  JSON / `for-in` 不可见，但第二个管理同一引擎的插件能辨认这是谁的写入，而不是互相无声覆盖。
- **不认领自己还原不了的 config**：`headroomTokens` 过不了引擎自己的 schema（`assertNonNegativeInteger`
  拒负数），所以**没有本插件标记却是负数**的 config，只可能是别人先写了哨兵值。这种情况下插件**跳过
  那个引擎并告警**，而不是把它当「原值」捕获 —— 否则暂停时会把别人的毒值原样写回去。引擎此时的行为
  本来就已经是我们要的，跳过不损失任何东西。
- **状态文件带版本**：`{version, enabled, thresholdRatio, summarizationProvider, summarizationModel}`。
  读取时 v1 的裸 `{thresholdRatio}` 照常工作，并在首次装载时升级写回。

> 这是本插件和基线 `dsh-compaction-threshold` 之间最实质的差别：它直接写 `engine.config` 而不保存
> 原值，停用之后进程里每个引擎仍然带着 `headroomTokens: -1e6`，一直到重启为止。

---

## 安装

不依赖 `dsh-compaction-threshold`，也不依赖 `@dsh-plugin/dsh-auxiliary`，可以独立运行。
宿主侧只 import 三个 Node 内置模块加 `@deepseek-ai/schemastery`；客户端只 require `react` 和
`@deepseek-ai/dsh-client-ui-primitives`。

```bash
git clone https://github.com/NoiraBaka/dsh-compact-suite.git
cd dsh-compact-suite
npm pack          # 得到 dsh-compact-suite-2.5.0.tgz
```

然后在 DSH 的「设置 → 插件 → 安装」里选这个 `.tgz`，或让 agent 用插件管理器指向该文件的绝对路径。

**必须用 tarball，不能用 `link:`** —— 插件要 import `@deepseek-ai/schemastery`，符号链接会让 Node
沿真实路径向上查找而找不到宿主包。

本包自带的 `cordis.patch.yml` 已经包含挂载行和默认配置。配置必须写在**顶层同 id 行**上，不能塞进
`insert` 块内部 —— `insert` 块内的行无法被 configEditor 唯一定位，设置页写入会被 compose 自检拒绝。

---

## 配置

写在插件行上（顶层同 id 行 → 设置页可改）。**这些只是首次运行的初始值**；之后以面板/状态文件为准。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `summarizationProvider` | `deepseek-account` | 摘要 provider |
| `summarizationModel` | `deepseek-flash` | 摘要 model |
| `thresholdRatio` | `0.8` | 初始触发比例 |

两个 `summarization*` 留空 = 跟随会话模型。

面板上的改动写到 `$DSH_HOME/compact-suite.json`，优先于配置里的 `thresholdRatio`。

压缩记录写在 `$DSH_HOME/compaction-log.json`，最多保留 200 条。**安装之前的压缩也会被补录**：
三个压缩事件是持久化的，插件启动时回放会话日志，把已有的压缩补进记录里（标为 `historical`），
按 `compactionId` 去重。

---

## HTTP 接口

面板用的就是这几个接口，也可以直接调：

| 路由 | 说明 |
| --- | --- |
| `GET /compact-suite/api/state?session=<id>` | 阈值、开关、路由、provider 列表、`contextWindow`、`thresholdTokens`、`ratioIsBinding`、引擎数、`ownedEngines`（真正带标记的引擎数）、实际 `headroomTokens` |
| `POST /compact-suite/api/state` | `{thresholdRatio?, summarizationProvider?, summarizationModel?, enabled?}` |
| `GET /compact-suite/api/log?session=<id>` | 压缩记录，新的在前，每条带 `provider` / `model` |
| `POST /compact-suite/api/compact?session=<id>` | 立即压缩：跑本 composition 的 `/compact`，返回 `{commandId, kind, text}` |
| `GET /compact-suite/api/models?provider=<p>` | `ctx.llm.listModels(provider)` |

---

## 与同类插件的关系

压缩这块生态里已经有不少插件，取向各不相同。本插件把**时机、执行者、口径、生命周期**放在一处管。

| | `dsh-compaction-threshold` 1.0.3 | `@dsh-plugin/dsh-auxiliary` 0.6.4 | 本插件 |
| --- | --- | --- | --- |
| 覆盖触发阈值 | ✅ | — | ✅ |
| 摘要改走指定模型 | — | ✅（写在引擎行上） | ✅（写在 `llm` 接缝上，与引擎无关） |
| 暂停/卸载后还原引擎 | ❌ 不保存原值 | 未核对 | ✅ |
| 压缩记录带 provider/model | — | — | ✅ |
| 补录安装前的压缩历史 | — | — | ✅ |
| 图形界面 | — | — | ✅ |

阈值公式的覆盖方式、以及 `headroomTokens: -1e6` 这个抵消手法，都来自
[`dsh-compaction-threshold`](https://www.npmjs.com/package/dsh-compaction-threshold) 1.0.3（MIT）。
本项目的增量是模型路由、口径对齐、生命周期管理和界面。生态里还有 `dsh-handoff-compaction`
（面向小上下文模型）、`dsh-compaction-instant`、`dsh-compaction-cacheaware`、`dsh-smart-compact`、
`dsh-context-compass` 等。

### 兼容性

**仍然不建议和 `dsh-compaction-threshold` 同时启用，但两者共存时已经不会互相毒化。** 两者都会改写
同一批引擎实例上的 `config`。基线的写入不带本插件的标记，所以插件能把它认出来：**凡是没有本插件标记
却已经是负 headroom 的 config，一律跳过不接管**，因此不会把 `headroomTokens: -1e6` 当成「原值」记下来。
代价是那批引擎不受本插件的滑块控制（它们此时的行为本来就已经是「让比例说了算」，所以没有实际损失），
并且日志里会有一条一条的告警说明跳过了几个引擎。

**不要和 `@dsh-plugin/dsh-auxiliary` 的压缩模型路由同时启用。** 两者都拦 `llm/stream` 并改写
`purpose === 'compaction'` 的目标模型，同时开着以先注册者为准，结果不确定。

---

## 实现要点

- **浏览器半区走公开插槽**（`conversation.input.left`），不做 DOM 增强。抄 class 后缀匹配
  `div[role="dialog"]` 的做法，卡片结构一变就静默失效。
- **主题 token 全部核对过**（`cordis_inspect_query` → Theme 只导出 14 个 `--dsw-alias-*`）。
  此前写错了 4 个名字，全部掉进硬编码兜底色，深色模式下必然难看。
- **几何对齐相邻控件**：【技能】chip 是 32px 高、`1px solid var(--dsw-alias-border-l2)`、
  `font:inherit`、`.12s` 过渡。
- 弹层定位用宿主的 `useAnchoredPosition`（`@deepseek-ai/dsh-client-ui-primitives`），不写死偏移。
- 文案走 `ctx.locale` 的 zh/en 字典。

## 已知限制

- **接管依赖上游内部结构**：引擎发现靠 `fiber.store.compaction`，阈值覆盖靠替换已解析的 `config`
  对象。`@deepseek-ai/dsh-compaction-basic` 换了内部形状就可能失效 —— 启动自检会告警，不会静默失败。
- 只改动**已挂载**引擎实例的 `config`；磁盘上 `compaction-basic` 的默认值不受影响。
- 摘要路由依赖 `ctx.llm.stream` 的 waterfall 语义；宿主若改为不可拦截，路由会静默失效
  （压缩仍可用，回落会话模型）。
- **输出兜底是启发式的**：它拦 `max_completion_tokens` 小于等于 16384 的请求，把上限抬回压缩器的
  实际值。已知会误伤 `session-title-llm` 的 64 —— 无害，`max_completion_tokens` 是上限而非配额。
  这段逻辑针对的是 `dsh-llm-pi-ai` 的 `clampMaxTokensToContext`，上游改了这个函数就得跟着改。
  面板以 `outputRescue` 字段如实报告其状态。
- 面板里的 `窗口 → 触发点` 需要本会话已产生过一次请求（`request/context`）；此前显示「还未知」。
- **「立即压缩」要求 agent 空闲**：正在跑一轮、或已有一次压缩在进行时，官方命令会报
  `busy`，面板原样转述。压缩本身不能在回合中途插进去。
- 只在 **DSH `0.2.0-rc.2` + Windows** 上实机验证过。其他版本/平台没测。

---

## 归属

MIT。阈值覆盖与口径机制源自 `dsh-compaction-threshold` 1.0.3（MIT），本项目在其基础上重写并扩展；
摘要路由的接缝选择参考 `@dsh-plugin/dsh-auxiliary` 的 `compact-router`，按其思路独立重写，
**没有从它复制任何代码**。
