# 代码复用思维指南

> **目的**:创建新代码前先停下来想一想——它是不是已经存在了?

---

## 问题所在

**重复代码是不一致性 bug 的头号来源。**

当你复制粘贴或重写已有逻辑时:
- bug 修复无法传播
- 行为随时间逐渐分叉
- 代码库越来越难懂

---

## 写新代码之前

### 第 1 步:先搜索

```bash
# 搜索相似的函数名
grep -r "functionName" .

# 搜索相似的逻辑
grep -r "keyword" .
```

### 第 2 步:问自己这些问题

| 问题 | 若是…… |
|------|--------|
| 已存在相似函数? | 使用或扩展它 |
| 这个模式别处用过? | 沿用既有模式 |
| 它能成为共享工具函数? | 放到正确的位置去创建 |
| 我正在从别的文件复制代码? | **停下** —— 抽取为共享代码 |

---

## 常见重复模式

### 模式 1:复制粘贴函数

**坏**:把一个校验函数复制到另一个文件

**好**:抽取到共享工具模块,哪里需要哪里导入

### 模式 2:相似组件

**坏**:新建一个与现有组件 80% 相似的新组件

**好**:用 props / 变体扩展现有组件

### 模式 3:重复常量

**坏**:在多个文件里定义同一个常量

**好**:单一事实来源,处处导入

### 模式 4:重复的载荷字段提取

**坏**:多个消费方各自对同一批 JSON / 事件字段做局部断言:

```typescript
const description = (ev as { description?: string }).description;
const context = (ev as { context?: ContextEntry[] }).context;
```

哪怕代码只有两行,这也是重复的契约逻辑——每个消费方现在都有了自己对
「合法载荷」的定义。

**好**:把解码器、类型守卫或投影放到数据所有者旁边:

```typescript
if (isThreadEvent(ev)) {
  renderThreadEvent(ev);
}
```

**规则**:同一个无类型载荷字段被读取 2 处以上,就在出现第三个读取方之前
建立共享的类型守卫 / 归一化器 / 投影。

---

## 何时抽象

**应该抽象**:
- 同样的代码出现 3 次以上
- 逻辑复杂到可能藏 bug
- 多人可能都需要它

**不该抽象**:
- 只用一次
- 微不足道的一行代码
- 抽象本身比重复更复杂

---

## 批量修改之后

当你对多个文件做了同类修改:

1. **复盘**:所有实例都改到了吗?
2. **搜索**:跑一遍 grep 找漏网的
3. **考虑**:这该不该抽象?

### Reducer 应当使用穷举结构

当状态由类 action 值(`action`、`kind`、`status`、`phase`)派生时,优先用
一个 `switch` 的 reducer,而不是散落的 `if/else` 更新:

```typescript
// 坏 —— 按 action 分散的状态迁移难以审计
if (action === "opened") { ... }
else if (action === "comment") { ... }
else if (action === "status") { ... }

// 好 —— 一个 reducer 拥有整张迁移表
switch (event.action) {
  case "opened":
    ...
    return;
  case "comment":
    ...
    return;
}
```

当事件日志是事实来源时这一点尤其重要。reducer 就是文档化的重放模型;
展示代码和命令不应各自复制这个重放模型的片段。

---

## 提交前检查清单

- [ ] 搜索过是否已有相似代码
- [ ] 没有本应共享却被复制粘贴的逻辑
- [ ] 没有绕开共享解码器、重复提取无类型载荷字段的情况
- [ ] 常量只在一处定义
- [ ] 相似模式遵循相同结构
- [ ] reducer / action 迁移集中在一个 reducer 或命令分发器里

---

## 陷阱:Python if/elif/else 缺乏穷举检查

**问题**:Python 的 if/elif/else 链没有编译期穷举检查。给 `Literal` 类型(例如
`Platform`)新增一个值时,已有的 if/elif/else 链会静默落入 `else`,拿到错误的默认值。

**症状**:新平台只部分工作——某些方法返回 Claude 的默认值而不是平台专属值。不报任何错。

**示例**(`cli_adapter.py`):
```python
# 坏:"gemini" 落入 else,返回 "claude"
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    else:
        return "claude"  # gemini 悄悄拿到了 "claude"!

# 好:每个平台一个显式分支
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    elif self.platform == "gemini":
        return "gemini"
    else:
        return "claude"
```

**预防**:给 Python `Literal` 类型新增值时,搜索所有基于该类型的 if/elif/else 链,
为每个新值补显式分支。不要指望 `else` 对新值恰好正确。

---

## 陷阱:不对称机制产出同一结果集

**问题**:当两套不同机制必须产出同一文件集合(例如 init 用递归目录复制、update 用手工
`files.set()`)时,结构性变更(重命名、移动、加子目录)只会通过自动机制传播,手工那份
会静默漂移。

**症状**:init 完美工作,update 却把文件建在错误路径或干脆漏掉文件。

**预防**:
- **最好**:消除不对称——让手工路径调用自动路径(例如让 `collectTemplateFiles()`
  调用 `getAllScripts()`,而不是自己维护一份清单)
- **若不对称不可避免**:加一个回归测试,对比两套机制的输出
- 迁移目录结构时,搜索所有引用旧结构的代码路径

**真实案例**:`trellis update` 曾用手工 `files.set()` 维护 11 个脚本,而
`getAllScripts()` 早已跟踪了它们。修复:用手写清单换成 `for..of getAllScripts()`
循环。见 v0.4.0-beta.3 的 `update.ts` 重构。

---

## 模板文件注册(Trellis 专属)

向 `src/templates/trellis/scripts/` 新增文件时:

**唯一注册点**:`src/templates/trellis/index.ts`

1. 添加 `export const xxxScript = readTemplate("scripts/path/file.py");`
2. 加入 `getAllScripts()` 的 Map

就这样。`commands/update.ts` 直接使用 `getAllScripts()`——无需手工同步。

**为什么重要**:不在 `getAllScripts()` 注册,`trellis update` 就不会把文件同步到用户
项目,bug 修复和新功能都无法传播。

**历史**:v0.4.0-beta.3 之前,`update.ts` 自己手工维护文件清单,频繁与
`getAllScripts()` 脱节,导致 11 个 Python 文件在 `trellis update` 时被静默跳过。
修复方式就是消灭重复清单,让 `getAllScripts()` 成为单一事实来源。

### 新脚本快速自检

```bash
# 加完新 .py 文件后,确认它在 getAllScripts() 里:
grep -l "newFileName" src/templates/trellis/index.ts  # 应当匹配
```

### 模板同步约定

`.trellis/scripts/`(自用副本)与 `packages/cli/src/templates/trellis/scripts/`
(模板副本)必须保持完全一致。改完 `.trellis/scripts/` 后务必同步:

```bash
rsync -av --delete --exclude='__pycache__' .trellis/scripts/ packages/cli/src/templates/trellis/scripts/
```

**注意**:rsync 的源/目标路径写错会产生嵌套垃圾目录(例如
`.trellis/scripts/packages/cli/...`)。执行前务必核对路径。
