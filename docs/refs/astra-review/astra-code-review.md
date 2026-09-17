# agent-observe 第二阶段代码与样式审核

## 大前提

简化必须减少重复判断，同时保留“分层披露、三级边、折叠入口、准确计数”。把有效交互删掉，或把未知写成完成，都不算简化。

## 小前提

- 已逐段读完 `agent-observe/web/index.html` 全文。当前文件为 **731 行**，不是约 660 行；以下行号均针对本次文件。
- 文件 SHA-256：`938197f10b21e86dafc03c9ab594c3b7a975efd1b2c24a7f28d726ae02835933`。未执行 git 操作，未修改项目文件；没有独立确认它与 `a3ddf39` 的对应关系。
- 只读取得本机 `/api/data`：同步 #16、14 张业务卡，另有目标卡。对原文件中的 `plan/stateAt/renderLive` 做了 Bun 隔离执行；另算了颜色对比度和边选择反例。探针：`/tmp/astra-review-probe.ts`，结果：`/tmp/astra-review-probe.json`。
- **没有浏览器验收结论。** OpenCLI 因本机动态库缺失无法启动；CUA 返回没有可用浏览器。Safari 排版、真实焦点、像素位置、堆内存均未实测。下文明确区分源码判断、实际数据函数结果与构造反例。

## 结论

**保留六个视图态和测高后定位的结构。真正该删的是空函数、不可达判断、重复 class 更新，以及“其它卡”和 gap 的第二套布局。先修折叠与边选择的错误，再做局部瘦身；不要换框架或引入统一状态管理器。**

以下 `旧 → 新` 是修改建议，不是已应用补丁。代码块中的局部替换需成组实施，不能只取其中一行。

---

# 一、必改

## B1｜补双引号转义，避免事实文本破坏 HTML 属性

**位置：** `web/index.html:245, 514, 518, 638`。

旧：

```js
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
```

新：在同一行末尾增加：

```js
.replace(/"/g,'&quot;')
```

隔离结果：事实 `耗时 "118s"` 当前生成 `<div title="耗时 "118s"">`。同一函数还用于多个 `data-*` 属性，不能只修这一个 `title`。

**理由：** 一处补齐转义，比逐个调用点打补丁更简单，正常文字也不会改变。

## B2｜合并“其它卡”与常规分组布局，修复绕过折叠、gap 重复归属、无法收起

**位置：** `349–388, 430–460, 485–489, 535–545`。

### B2.1｜归属不匹配的卡也必须经过同一个折叠器

当前按 `subgoal.title` 建组，再要求 `card.zone` 与标题完全相同。实际数据中子目标标题是“14点需求拍板”，其它卡的 zone 是“实现、部署、质量”等；原 `plan()` 输出这个子目标的具体卡为 0，其余 13 张落入不参与折叠的 `others`。

不能把“实现”猜成某个子目标。最小改法是把未匹配卡放进一个明确标注“归属待确认”的显示组，复用原有列布局与折叠；它不是新业务节点。

旧：

```js
const others=[];
// 未匹配卡 → others
// 只有 zones 中的组经过 3 张上限
// renderInner 再用 449–460 行单独排 others/gaps
```

新：

```js
// 收集完 others 后、进入折叠循环前：
if(others.length){
  let key='归属待确认'; while(zones.includes(key))key+='·';
  zones.push(key);
  groups[key]={sub:null,mid:[],verify:[],concl:[],folded:[]};
  for(const c of others)
    groups[key][['change','risk','group'].includes(c.type)?'mid':c.type==='verify'?'verify':'concl'].push(c);
}
```

然后删除 `449–460` 的第二套堆叠块；zone 标题改为有 `sub` 才写“子目标”，否则只写“归属待确认”。**不要通过相似标题猜归属。**

### B2.2｜gap 只走所在分组，不再全局扫一遍

旧：

```js
const gaps=all.filter(c=>c.type==='gap');
return {all,zones,groups,others,gaps};
// 后续再次 for(const c of gaps) 写 pos[c.id]
```

新：

```js
return {all,zones,groups};
// 解构同步去掉 others/gaps；gap 已由组内 concl 列承接。
```

构造反例中，同一个 gap 同时出现在 `grp.folded` 和全局 `gaps`：它会计入“其余记录”，却又被定位显示。已在隔离 `plan()` 中确认；当前真实数据的 gap 均未匹配子目标，不代表真实页面已经触发这个特定反例。

### B2.3｜收起按钮看展开状态，不看“剩余折叠记录”

旧：

```js
const expandable=zones.includes(zr.z)&&(groups[zr.z].folded||[]).length>0;
```

新：

```js
const expandable=expandedZones.has(zr.z);
```

原因是展开后 `plan()` 会跳过折叠，`folded=[]`；旧条件恰好让展开态没有“收起”，折叠态反而显示“收起”。

计数继续从当前时点的隐藏集合计算；必须断言 `显示集合 ∩ 隐藏集合 = 空集`。本条不更改 `cardPrio()` 对状态的定义。

**理由：** 一套分组、一套折叠、一套布局，同时减少代码和重复计数风险。

## B3｜三级边只有一个强调计算，不能把邻居的边也全部点亮

**位置：** `82–85, 130–134, 549–620`。

当前有三个确定问题：

1. `main/ctx` 已添加，却没有对应的透明度样式；默认态并没有注释所说的淡化。
2. 先把 A 的邻居 B 放入 `hlIds`，再用 `hlIds` 判断边，会同时点亮 `A→B` 和 `B→C`。构造反例已确认第二跳混入。
3. 所有“妨碍”边都算默认主边，不看风险是否已解决。实际数据中 `RISK_JITTER` 已 resolved，它的三条妨碍边仍符合旧 `main` 条件。

### 默认等级只在建边时算一次

旧：

```js
p.classList.add(kind==='risk'?'main':'ctx');
// applyEmphasis 每次再按 dataset.k 重设 main/ctx
```

新：

```js
const obstacle=e.v==='妨碍'?f:e.v==='留下缺口'?tt:null;
const main=!!obstacle&&!['done','resolved'].includes(stateAt(obstacle,t));
p.classList.add(main?'main':'ctx');
// 标签 show0 的六条额度也按 main 计算。
// 删除 dataset.k 与 applyEmphasis 中重复重设 main/ctx 的一轮遍历。
```

历史风险边保留，只降回背景层，不删除。`kind` 仍可用于虚线与颜色。

```css
svg.edges path.ctx{opacity:.25}
svg.edges path.main{opacity:.65}
svg.edges path.hl{opacity:1}
```

保留原有 `.focusmode svg.edges path:not(.hl){opacity:.05}`，它在选择态压低无关边。

### 卡片邻居与边端点分开判断

保留 `hlIds` 给卡片使用；边只判断选中卡本人。代理筛选仍按署名集合判断。

```js
const edgeHit=p=>focusId
  ? p.dataset.f===focusId||p.dataset.t===focusId
  : hlIds.has(p.dataset.f)||hlIds.has(p.dataset.t);

// 替换“先全清空，再逐个加回”的边遍历：
esvg.querySelectorAll('path,text').forEach(p=>{
  const hit=focusing&&edgeHit(p);
  p.classList.toggle('hl',hit);
  if(p.tagName==='text')
    p.classList.toggle('show',focusing?hit:p.classList.contains('show0'));
});
```

配套删除 `599–606` 的边清空、重复设级、标签恢复及提前 return；`hlIds` 只在有 `focusId` 或 `selAgent` 时收集。卡片同样用一次 `toggle('hl',...) / toggle('sel',...)` 取代先清再加。

**理由：** 默认等级是稳定数据，强调是一次派生计算，不应每次鼠标经过都重做四轮 class 修补。

## B4｜修三处样式落空，再提高次要文字对比度

**位置：** `10, 58, 78, 127, 487`。

### 区域框没有横向尺寸

旧：

```js
d.style.cssText+=`top:${zr.top}px;height:${zr.h}px`;
```

新：

```js
d.style.cssText=`left:${g.x(1)-12}px;right:12px;top:${zr.top}px;height:${zr.h}px`;
```

`.zone` 本身也没给宽度，内部 `.zh` 又是绝对定位；不能指望文字撑开区域框。此为源码判断，尚无浏览器像素复核。

### 未解决数的颜色选择器写错层级

旧 → 新：

```css
.foldentry .t2 .uns{color:var(--amber)}
/* → */
.foldentry .uns{color:var(--amber)}
```

`mkFold()` 把 `.uns` 放在 `.t1`，旧规则不会命中。

### 次要文字不能灰到看不清

旧 → 新：

```css
--dim:#626b7a; /* → */ --dim:#8993a3;
/* .live .lcell .hint */ color:#3d4a63; /* → */ color:var(--dim);
```

按标准相对亮度公式计算：

| 前景 / 背景 | 对比度 |
| --- | ---: |
| 原 dim / panel | 3.239:1 |
| 新 dim / panel | 5.615:1 |
| 新 dim / panel2 | 5.192:1 |
| 原 hint / live 渐变上端 #141b2a | 1.933:1 |

这些是 9.5–12px 的正常文字，不适用“大字 3:1”的宽松条件。普通文字采用至少 4.5:1 的门槛。[W3C 对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

数值未包含卡片整体 `opacity:.3` 的混色效果，不能据此宣布整页无障碍通过。

**理由：** 修正未命中的规则和低对比文字，远比再增加一组主题变量有用。

## B5｜历史不能回退到未来；抽屉内容必须跟随当前数据

**位置：** `330, 499, 657–665, 683–715`。

### 历史选择统一为“时点以内最后一条”

旧：

```js
// stateAt 默认使用第一条，即使它晚于 t
let s=a.length?a[0].s:'doing';
// live 默认第一条；stamps 找不到当前时点就拿最后一条
const st=(D.stamps||[]).find(s=>s.at===t)||D.stamps[D.stamps.length-1]||{};
```

新：用一处小函数替换三套选择逻辑，且不要求输入数组有序：

```js
const atOrBefore=(xs,t)=>(xs||[]).reduce((a,x)=>
  x.at<=t&&(!a||x.at>=a.at)?x:a,null);
const stateAt=(c,t)=>atOrBefore(c.states,t)?.s||'unknown';
// stTxt 增加 unknown:'状态未知'
// renderLive：
const e=atOrBefore(D.live,t)||{},st=atOrBefore(D.stamps,t)||{};
```

构造反例中，`t=0` 会读到 `at=5` 的完成状态、进展和时间戳。真实数据也存在：时间戳从 #1 开始，查看 #0 时旧逻辑返回 #16 的时间戳。

这里只修展示层可判断的未来泄露。`facts/title/steps` 没有逐条时间版本，前端不能据此证明整段历史内容都是真实旧快照；不要在此次审核中宣布“历史完全通过”。

### 抽屉渲染与“打开动作”分开

旧：

```js
if(drawerId&&selectedId==null){/* 抽屉保持 */}
```

这是一段空代码，不会刷新已打开的抽屉。地图换到历史或数据更新后，抽屉仍可能留着旧文本。

新：把 `openDrawer()` 内 `dHead/dBody` 填充及关系绑定原样移入 `renderDrawer(c)`；`openDrawer()` 只设 `drawerId/selectedId`、调用它并打开面板。用下段替换空代码：

```js
if(drawerId){
  const c=all.find(c=>c.id===drawerId);
  if(c)renderDrawer(c);else closeDrawer();
}
```

不要在轮询里调用 `openDrawer()`，否则会把用户后来选中的卡又改回抽屉卡。正文重绘时保存并恢复 `dBody.scrollTop`。

**理由：** 一处负责取历史值，一处负责画抽屉，能删重复选择并避免同页显示两个时点的结论。

## B6｜修键盘事件与隐藏面板，不用“重绑事件”解决焦点问题

**位置：** `91–92, 153–154, 531–533, 535–546`。

### 卡片 Enter 不应吞掉子按钮的 Enter

旧：卡根的 `onkeydown` 对所有冒泡 Enter 调用 `preventDefault()`。

新：在原条件前限制事件目标：

```js
if(e.target!==d)return;
if(e.key==='Enter'){ /* 保留原选择/打开逻辑 */ }
```

否则 Tab 到“详情”按钮后按 Enter，首次可能只选中卡片，而不是让按钮执行默认点击。

### 折叠入口用原生按钮

旧 → 新：

```js
document.createElement('div');d.className='foldentry';
// →
document.createElement('button');d.type='button';d.className='foldentry';
```

内部三段 `div` 改成 `span`，加 `.foldentry>span{display:block}`，根样式加 `text-align:left;font:inherit`。保留原点击处理，不再额外写 Enter/Space 模拟代码。

### 关闭抽屉时不让键盘进入屏外面板

在原规则内增加属性，不新建一组动画：

```css
#drawer{ /* 原属性保留 */ visibility:hidden; }
#drawer.open{transform:none;visibility:visible}
```

打开动作最后聚焦关闭按钮；关闭动作保留原回焦点逻辑。该最小修复会取消关闭时可见的滑出效果；不值得为这段效果增加延迟状态。

**理由：** 原生按钮与明确焦点比自制按键模拟更短，也不会把“详情可达”变成仅鼠标可用。

---

# 二、建议

## S1｜删除确定无效的代码，不删除暂时没有数据的能力

| 位置 | 旧 → 新 | 理由 |
| --- | --- | --- |
| 621–622 | 删除 `drawDefaultLabels(){}`、`esvgLabels(on){}` | 全文件无调用，函数体也为空。 |
| 523 | 删除 `e.target.dataset.agent` 分支 | `fillCard` 及其子元素从未生成 `data-agent`。 |
| 518 | 删除详情按钮 `data-d` | 点击通过 `closest('.dtl')` 判断，值没有读取者。 |
| 204–206 | 删除 `.lcell` 的 `data-c` | live 点击只切换本格 `.open`，没有使用这个字段。 |
| 469–472、89 | 删除 `vis`、`.off` 切换及 `.card.off`；保留状态变化判断 | `all` 已由 `visibleAt` 过滤，且本轮 t 没变，`vis` 必定为真。 |
| 509–512 | 删除 acc 的 `style="display:-webkit-box"` | `.clamp2` 已声明完全相同属性。 |
| 567–570、584 | 删除 `const hz=hor`，直接用 `hor` | 没有第二种含义。 |
| 499 | 不保留空 `if` | 已由 B5 的真实刷新替换。 |

`.card.off` 删除应与对应 JS 一起做，不要留下另一个空约定。`group/rgOpen` 有真实创建与点击路径，只是当前 14 卡样本没有 group，**不能当死代码删掉**。

## S2｜保留测量与定位两阶段，只测最终会显示的卡

**位置：** `397–429, 466–473`。

旧：`all` 包括折叠卡；先把全部挂载、测量，没 `pos` 的卡留在 DOM 内 `visibility:hidden`。

新：在 `plan()` 返回值基础上拼出本轮实际显示集合：

```js
const shown=[...all.filter(c=>c.id==='GOAL'),
  ...zones.flatMap(z=>[groups[z].sub,...groups[z].mid,
    ...groups[z].verify,...groups[z].concl].filter(Boolean))];
```

挂载与最终定位的两个 `for` 使用 `shown`，署名统计仍看全部当时存在的卡；不可把“折叠”当“没参与”。统一用已有 `G`，删除第二次 `const g=geom()`，把布局中的 `g.` 改为 `G.`。`geom()` 内左右边距使用现有 `PAD`：

```js
const W=$('wrap').clientWidth-2*PAD;
return {colW,x:i=>PAD+i*(colW+GAP)};
```

**理由：** 删除隐藏卡的无用 DOM 与重复取宽度即可；不用为几十张卡引入虚拟列表。

## S3｜折叠入口的 hl 没有“专门高亮样式”，但当前并非完全无效

**位置：** `132, 598, 615`。

本文件**没有** `.foldentry .hl`，也没有 `.foldentry.hl`。实际规则是：

```css
.focusmode .foldentry:not(.hl){opacity:.25}
```

`applyEmphasis()` 又给所有折叠入口无条件加 `.hl`，效果是所有入口保持原透明度，不会变蓝。这与“没有视觉作用”不同。

保留现有效果的最小化：

```diff
- .focusmode .foldentry:not(.hl){opacity:.25}
- 清空所有 foldentry 的 hl
- 给所有 foldentry 加 hl
```

折叠入口始终清晰，避免隐藏内容的唯一入口也被淡化。若以后要只强调相关折叠组，需要真实成员关系，不要现在添加一个看似有用的 `.foldentry.hl` 蓝边。

**理由：** 删掉永远相互抵消的状态操作，视觉行为完全不变。

## S4｜六个视图态不必合并，但 hover 和署名反馈要修正

**位置：** `259–260, 404, 639, 648–649`。

- 切会话重置及重建卡 DOM 前，把 `hoveredId=null` 与现有重置放在同一处；旧元素被移除时不能依赖它一定触发 `mouseleave`。
- chip 点击后当前只 `applyEmphasis()`，不会重画 `.on`；参与者面板选择则重画。两个入口统一成一个小函数：

```js
function toggleAgent(key){
  selAgent=selAgent===key?null:key;
  applyEmphasis();renderSig(viewTick);
}
```

chip 保留 `stopPropagation()`；面板保留关闭动作，其余调用 `toggleAgent(...)`。不要求统一成一条全局 click 代理。

**理由：** 状态数量不是问题，两个入口改变同一状态却给出不同反馈才是问题。

## S5｜删除多余 grid 行声明，合并重复样式

**位置：** `88, 91–93, 106–108`。

### 卡片网格

旧 → 新：

```css
/* 从 .card 删除 */ grid-template-rows:auto auto auto 1fr;
/* 保留 */ display:grid;gap:4px;
```

卡片没有固定高度，最后一行不需要 `1fr`；没有 fact 的卡只有三个子元素，显式四行还可能留下多余空行间隔。让隐式行按内容高度排即可。

保留 `.clamp2` 的完整组合：`display:-webkit-box`、`-webkit-box-orient:vertical`、`-webkit-line-clamp:2`。父级是 grid 不等于该子元素不能使用旧 WebKit box；不要把子元素改成 `display:grid`。前缀组合的依赖关系见 [MDN line-clamp](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/line-clamp)。本次未实际测试旧 Safari，不声称所有版本通过。

### outline

当前 `.card:focus-visible` 与 `.card.sel` **不是画两个 outline**：它们优先级相同，后写的 `.sel` 把 offset 从 2px 覆盖为 1px。

旧两条 → 新一条：

```css
.card:focus-visible,.card.sel{outline:2px solid var(--blue);outline-offset:2px}
```

折叠按钮保留浏览器焦点指示；如需统一再把 `.foldentry:focus-visible` 加入同一规则。

### 状态颜色

```css
.card .st-done,.card .st-resolved{background:#14532d;color:#86efac}
.card .st-partial,.card .st-risk{background:#574308;color:#fde68a}
```

替换原来四段重复声明，不改其它 doing/failed 样式。

**理由：** 删除没有布局目的的轨道与重复属性，避免为“统一风格”增加配置层。

## S6｜间距只改卡片内两处，先不全站换尺寸体系

**位置：** `88, 97–98`。

旧 → 新：

```css
.card{padding:9px 12px 8px} /* → padding:10px 12px */
.card h4{font-size:13.5px;line-height:1.32} /* → 14px / 20px */
.card .fact{font-size:11.5px;line-height:1.45} /* → 13px / 18px */
```

卡内仍 4px 间隔，卡间仍 12px，不改 28px 列间距。核心事实不应比署名大不了多少；增加后的卡高由现有实测布局处理，必须重跑首屏高度检查，不能保证“字体变大后仍一屏”。

可把 `prefers-reduced-motion` 规则放在 CSS 末尾，关闭 pulse/flash 和切换动画；这属于有收益的补充，不是修当前 clamp 的必要条件。

**理由：** 先保证正文可读和局部节奏，避免把小审核变成全套设计变量改造。

## S7｜图节点查询可复用一个索引，不增加多个长期缓存

**位置：** `561, 612, 627, 633, 693, 704`。

多处反复写 `[DATA.goal,...DATA.cards]`。最小选择：本轮 `renderInner()` 建一个 `Map(id → card)`，替换 `drawEdges` 与抽屉关系中的两次线性查找；或只在各函数开头留 `const cards=[D.goal,...D.cards]`。

旧 → 新示意：

```js
const f=[D.goal,...D.cards].find(c=>c.id===e.f);
// →
const f=byId.get(e.f);
```

**优先选局部数组版本。** 42 张卡不是性能瓶颈；只有索引能同时删掉多处查找时才升级为每轮 Map，不再缓存一套 agent/edge/zone 索引。

**理由：** 提取重复表达式有收益，提前建立一堆需要同步的缓存没有收益。

---

# 三、明确不改

## N1｜不把六个视图态硬塞成一个模式变量

**旧 → 新：保持** `selectedId / drawerId / hoveredId / selAgent / expandedZones / rgOpen` 独立。

选中卡可以不同于正在阅读的抽屉卡；hover 是临时覆盖；署名过滤可在 hover 结束后恢复；两个 Set 分别控制整组与过程体。打包成 `viewState={...}` 只是换写法，不会减少这六个事实。

**理由：** 独立状态有独立含义，合并反而增加条件判断。

## N2｜不强行把“两遍 layout”改成一遍

**旧 → 新：保持** 挂载到最终宽度 → 测高 → 定位 → 画边；只采用 S2 的局部删除。

这不是两次完整 render。中文换行、验收条件和摘要都会改变高度；用公式猜高度会退回上一轮的截断问题。折叠入口的额外测量可接受，不必为了几十张卡引入复杂调度。

**理由：** 测量是必要阶段，删掉它只是把确定结果换成估算。

## N3｜不以“防内存泄漏”为由改成全局事件代理

**位置：** `521–533, 639, 648–653, 702–706, 724–728`。

**旧 → 新：保持** 元素上的 `onclick/onmouseenter/onmouseleave/onkeydown` 赋值。

源码核查结果：

- 旧卡移除后，没有一个持续增长的数组或 Map 保存旧 DOM；`pos/adj/prevStates` 保存的是位置、ID 或状态，不是元素。
- 元素与闭包互相引用不等于泄漏；不可达对象仍可回收。[MDN 内存管理说明](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Memory_management)
- `pcAll.onclick`、`pcSearch.oninput` 是覆盖旧处理函数，不会像反复 `addEventListener` 一样累加。
- 文档事件、轮询定时器和 ResizeObserver 在脚本顶层注册一次，不在 `render()` 里累加。

**没有发现由这些绑定方式导致持续保留旧节点的路径；这不是堆快照证明“绝无泄漏”。** 整体重建会造成分配和失焦，属于另一类问题，不能混称泄漏。

**理由：** 当前绑定简单且数量小，重写为委托只会把逻辑搬到 selector 分支里。

## N4｜不改折叠优先级来“凑好看”的未解决数字

**旧 → 新：保持** `cardPrio()` 作为展示优先级；本轮通过 B2 先保证隐藏集合准确。

源码中 `cardPrio===0` 同时涵盖失败、部分证实、风险、缺口。它不天然等于“独立且未关闭的问题数”。如果业务需要把一次历史失败视为已被后续修复覆盖，应由明确证据关联决定，不能在 UI 中看到 PASS 就扣掉失败数。

当前 `done` 的 risk/gap 也会得到优先级 0；要不要视为关闭必须先明确数据约定，不能为了缩短代码擅自等同于 `resolved`。本轮不能据此保证所有业务状态的“未解决”含义都已准确。

**理由：** 排序优化不能顺手改写业务判断。

## N5｜不顺手做全图缩放、图引擎、虚拟列表或全站 CSS 重构

**旧 → 新：保持** 单文件、原生 JS/CSS/SVG、现有六类业务语义与渐进披露。

**理由：** 当前收益最大的是修局部分支和重复计算，不是新增框架。

---

# 四、行数与实施边界

1. 审核基线是 **731 行**；交付必须 `wc -l <= 731`，不是按口头约 660 行验收。
2. 先做 B2 的布局合并、B3 的单轮 class 更新、S1 的死代码删除、S3/S5 的规则合并，用删掉的行数覆盖必要修复。
3. 不接受把多个控制分支挤成一行来达标。展示的 diff 片段需合并后再统计，本报告**没有声称整组补丁已经做到净减行**。
4. S6/S7 等建议不是必须一起落地；如果合并后仍超过 731 行，退掉非必要建议，不削掉未知态、历史边界或折叠计数保护。
5. 本次不改文件，不提交，不发布。任何源码改动后的功能通过结论需要另跑浏览器验收。

# 五、对上一轮验收门槛的影响复核

| 原门槛 | 此次建议是否影响 | 必须复跑的内容 / 当前证据边界 |
| --- | --- | --- |
| 1920×1080、无横向滚动、首屏可判断 | 是：B2/B4/S2/S5/S6 | 未匹配 zone、3 卡折叠、较大正文、区域框宽度；本次没有浏览器通过记录。 |
| 卡片溢出 | 是：B1/S2/S5/S6 | 中文长标题、无 fact、3 条以上 acc、带引号与长路径；旧 Safari clamp 需实机或对应浏览器验证。 |
| 全文可达 | 是：B5/B6/S1 | 详情按钮、所有事实/步骤、抽屉更新后滚动位置、闭合抽屉不可 Tab 进入。 |
| 单 zone 9/20 张，折叠数准确 | **直接影响：B2** | 匹配组与归属待确认组；展开后能收起；gap 不同时显示又计入隐藏；展示/隐藏集合完整无重复。 |
| 16 个 agent，身份与署名完整 | 是：S2/S4 | 折叠不减少参与者统计；chip 与面板选中反馈一致；多人同角色不合并。 |
| 52 条边，主线清楚、直接关系可访问 | **直接影响：B3/S3** | A→B→C 选择 A 不点亮 B→C；已解决风险不占默认主标签；六条默认标签限额仍有效。现有跨列贝塞尔曲线未做避障，不能把本次 class 修复当作“跨列线不穿卡”已通过。 |
| 持续同步不跳位、新增可定位 | 是：B5/S2/S4 | 抽屉最新内容与滚动、hover 清理、键盘焦点。当前每 5 秒仍重建地图，概览仍可能按 born 重排；本次简化不等于实现上一轮的完整视角冻结。 |
| 诚实性：范围、冲突、待验证可见 | **直接影响：B2/B3/B5** | 未解决计数不能重复；历史风险边保留；无历史值不猜 doing/done。`pickFact()` 仍是关键词选择，不能证明它理解了“风险已排除”等语义。 |
| 历史回放无未来结果 | **直接影响：B5** | #0 缺时间戳、第一条状态晚于 t、打开抽屉后切历史。未版本化的 facts/title/steps 仍是数据边界，不宣称全量通过。 |
| Tab/Enter/Esc 与文字放大 | **直接影响：B6/S5/S6** | 折叠入口可聚焦、详情按钮 Enter 不被吞、关闭回焦、放大后实测高度。参与者/live/关系行还有 div/span 点击入口，本次最小修复不等于整页键盘覆盖。 |
| 5 秒内理解目标、缺口、负责人 | 是：B2/B3/B4/S4/S6 | 让未参与实现的人重新看概览测试；代码审查和对比度计算不能代替这项。 |

**最终把关意见：可以做局部净减行整理，但不能只删空函数就收工。折叠路径、默认边等级、历史取值和低对比文字是必须一起处理的问题；六个状态和两阶段测高不是应当消灭的复杂度。**

CODE-REVIEW-DONE
