# 跨层思维指南

> **目的**:实现之前,想清楚数据在各层之间的流动。

---

## 问题所在

**大多数 bug 发生在层边界,而不是层内部。**

常见的跨层 bug:

- API 返回格式 A,前端期望格式 B
- 数据库存 X,服务层转成 Y 时丢了数据
- 多个层用不同方式实现了同一逻辑

---

## 实现跨层功能之前

### 第 1 步:画出数据流

把数据的移动路径画出来:

```
来源 → 变换 → 存储 → 读取 → 变换 → 展示
```

对每一个箭头问:

- 数据此刻是什么格式?
- 可能出什么错?
- 谁负责校验?

### 第 2 步:识别边界

| 边界 | 常见问题 |
|------|----------|
| API ↔ Service | 类型不匹配、字段缺失 |
| Service ↔ Database | 格式转换、null 处理 |
| 后端 ↔ 前端 | 序列化、日期格式 |
| 组件 ↔ 组件 | props 形状变化 |

### 第 3 步:定义契约

对每个边界:

- 精确的输入格式是什么?
- 精确的输出格式是什么?
- 可能发生哪些错误?

---

## 常见跨层错误

### 错误 1:隐式格式假设

**坏**:不核实就假设日期格式

**好**:在边界处做显式格式转换

### 错误 2:校验逻辑分散

**坏**:多个层校验同一件事

**好**:在入口处校验一次

### 错误 3:抽象泄漏

**坏**:组件知道数据库 schema

**好**:每一层只认识相邻的层

### 错误 4:每个消费方各自解析同一载荷

**坏**:某个命令读取 JSONL 事件并内联断言字段:

```typescript
const thread = (ev as { thread?: string }).thread;
const labels = (ev as { labels?: string[] }).labels;
```

看起来很局部,但这意味着每个消费方都私有一份事件契约。下次字段变更会改到一个命令、
漏掉另一个。

**好**:在事件边界解码一次,然后导出类型化的投影:

```typescript
if (!isThreadEvent(ev)) return false;
return ev.thread === filter.thread;
```

**规则**:对追加式日志、JSON 流、RPC 载荷或配置文件,为以下内容建立唯一的所有者:

- 事件 / 载荷类型定义
- 从 `unknown` 出发的类型守卫与归一化
- UI 命令使用的元数据投影
- 从事实来源重放状态的 reducer

渲染代码可以格式化字段,但不得重新定义载荷契约。

---

## 跨层功能检查清单

实现前:

- [ ] 画出了完整数据流
- [ ] 识别了所有层边界
- [ ] 定义了每个边界处的格式
- [ ] 确定了校验发生的位置

实现后:

- [ ] 用边界值测试过(null、空、非法)
- [ ] 核验了每个边界的错误处理
- [ ] 检查了数据往返(round-trip)不丢失
- [ ] 确认消费方导入的是共享解码器 / 投影,而不是局部断言载荷字段
- [ ] 确认派生状态回指源事件标识(`seq`、`id`、`version`),
      而不是另造第二个游标

---

## 跨平台模板一致性

在 Trellis 中,命令模板(例如 `record-session.md`)以相同或近似的内容存在于
**多个平台**目录。这是一个跨层边界。

### 检查清单:修改任何命令模板之后

- [ ] 找出拥有同一命令的所有平台:`find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] 更新所有平台副本(Markdown `.md` 与 TOML `.toml`)
- [ ] Gemini TOML:注意行续符(`\\` 与 `\`)和三引号字符串的适配
- [ ] 运行 `/trellis:check-cross-layer` 确认没有遗漏

**真实案例**:在 Claude 平台更新了 `record-session.md` 使用 `--mode record`,
却忘了 iFlow、Kilo、OpenCode 和 Gemini——被跨层检查逮住。

---

## 生成的运行时模板升级一致性

有些生成文件既是文档又是运行时输入。在 Trellis 中,`.trellis/workflow.md` 会被
`get_context.py`、`workflow_phase.py`、SessionStart 过滤器和逐轮 hook 解析。模板变更
必须同时对照全新 init 和版本升级两条路径验证。

### 检查清单:修改运行时会解析的模板之后

- [ ] 找出读取该模板的每一个运行时解析器,而不只是安装它的文件写入器
- [ ] 检查相关语法是否位于标签块等显式管理区域之外
- [ ] 验证全新 `init` 的输出,以及写入旧版 `.trellis/.version` 的版本化 `update` 场景
- [ ] 用一份旧版原始模板夹具加升级回归,断言安装后的文件达到当前打包形态
- [ ] 更新拥有该运行时契约的后端 spec

**真实案例**:Codex inline 模式把工作流平台标记从 `[Codex]` /
`[Kilo, Antigravity, Windsurf]` 改为 `[codex-sub-agent]` /
`[codex-inline, Kilo, Antigravity, Windsurf]`。全新 init 是对的,但 `trellis update`
只合并 `[workflow-state:*]` 块,块外的旧标记被原样保留。结果:升级后的项目拿到了新的
hook 脚本和旧的工作流路由,`get_context.py --mode phase --platform codex` 会返回空的
Phase 2.1 详情。

---

## 版本化文档边界

版本化文档是一个跨层边界:源路径、`docs.json` 的版本路由、渲染出的版本选择器,
三者必须描述同一条发布线。

### 检查清单:编辑版本化文档之前

- [ ] 确定目标发布线:stable、beta 还是 RC
- [ ] 核对所编辑的 MDX 路径属于该发布线:
  - stable:`docs-site/{start,advanced,...}` 与 `docs-site/zh/{start,advanced,...}`
  - beta:`docs-site/beta/**` 与 `docs-site/zh/beta/**`
  - RC:`docs-site/rc/**` 与 `docs-site/zh/rc/**`
- [ ] 核对 `docs.json` 导航把版本标签指向同一路径
- [ ] 提交前在相反的目录树里 grep 发布线专属术语
- [ ] beta 内容出现在根发布路径下时,按源路径 bug 处理,
      而不是渲染 bug

**真实案例**:一个 beta 专属的任务工作流变更,把 `prd.md` + `design.md` +
`implement.md`、任务创建征询、Codex 模式横幅写进了根目录的 `start/` 和 `advanced/`
路径。文档站随后在 Release 选择器下展示出了 0.6 beta 的行为。修复方式是恢复根发布
文档、把 0.6 内容移到 `beta/` 与 `zh/beta/`,并对根发布树增加 beta 标记的 grep 审计。

---

## 模式探测检查清单

当 CLI 通过探测远程资源来自动判定模式(例如检查 `index.json` 是否存在来区分
marketplace 与直连下载)时:

### 实现前:

- [ ] 探测在**所有**使用其结果的代码路径中都会执行(交互式、`-y`、各种 `--flag` 组合)
- [ ] 区分 404 与瞬时错误——不要把两者都当成「不存在」
- [ ] 瞬时错误**中止或重试**,绝不静默切换模式
- [ ] 上下文变化时(例如用户切换源)**重置**共享状态(缓存、预取数据)
- [ ] **快捷路径**(例如 `--template` 跳过选择器)必须具备与探测路径同等的错误处理
      质量——检查下游函数没有调用一刀切的包装器

### 实现后:

- [ ] 从探测结果到模式判定分支逐路径追踪——没有遗漏的 fallthrough
- [ ] 外部格式契约(giget URI、raw URL)有测试,或至少以注释形式文档化
- [ ] 元数据读取要么消费完整响应、要么用流式解析器——绝不把固定大小的前缀当完整 JSON 解析
- [ ] 从解析片段重组复合标识符时,核实**所有**字段都在且**位置正确**
      (例如 `provider:repo/path#ref`,而不是 `provider:repo#ref/path`)
- [ ] 核实快捷路径之后调用的 **action 函数**内部没有再用旧的一刀切 fetch——在错误
      区分有意义的地方,它们必须使用探测级别的变体

**真实案例**:自定义 registry 流程在 3 轮评审中揪出 8 个 bug:(1) 探测只在交互模式
运行;(2) 瞬时错误落入错误模式;(3) giget URI 的 `#ref` 位置不对;(4) 预取的模板
跨源切换泄漏;(5) `--template` 快捷路径绕过探测,但 `downloadTemplateById` 内部用了
一刀切的 `fetchTemplateIndex`,把超时变成了「模板不存在」。

**真实案例**:agent 会话的更新提示用 `response.read(4096)` 拉取 npm `latest` 元数据,
然后当作完整 JSON 解析。`@mindfoldhq/trellis` 的包元数据超过 4 KB,JSON 被截断、解析
静默失败,首个会话注入就没有显示更新提示。修复:先读完整个响应再解析,并加了
`version` 后跟 8 KB 元数据尾巴的回归。

---

## 何时编写流程文档

以下情况要写详细流程文档:

- 功能跨越 3 个以上的层
- 涉及多个团队
- 数据格式复杂
- 该功能曾出过 bug

---

## 事件日志 / 投影边界

追加式日志是跨层契约。一个事件要经过:

```
CLI 输入 → 事件写入器 → events.jsonl → 读取器 → 过滤器 → reducer → 展示
```

### 检查清单:新增事件类型或字段之后

- [ ] 把事件类型加进中央事件分类表
- [ ] 在事件层添加类型化的事件变体或类型守卫
- [ ] 为来自用户输入或 JSON 的数组/对象字段添加归一化辅助函数
- [ ] `seq` / `id` 的分配只保留在事件写入器
- [ ] 过滤器和 reducer 消费类型化事件守卫,而不是局部断言
- [ ] 展示代码消费 reducer 输出或类型化事件,而不是原始 JSON
- [ ] 至少加一条回归,证明历史重放与实时过滤使用同一个过滤模型

**真实案例**:thread channels 新增了 `kind: "thread"`、`description`、`context`、
labels 和 `lastSeq`。第一版实现的重放是对的,但若干命令仍在用局部断言重新解析事件
载荷字段。修复方式:让核心事件层拥有 `ThreadChannelEvent` 和 `isThreadEvent`,让
`reduceChannelMetadata` 成为唯一的频道元数据投影,让 `reduceThreads` 成为唯一的
thread 重放 reducer。
