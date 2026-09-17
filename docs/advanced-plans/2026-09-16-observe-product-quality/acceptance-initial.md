# 接手验收：658ecff

## 大前提

代码改过不等于产品通过，需要实际页面和数据链路同时成立。

## 小前提

逐行对照原报告 B1–B6，读取本机当前 API，并在隔离 Chromium 中用真实数据快照渲染原文件。

| 原项 | 结果 | 证据 |
| --- | --- | --- |
| B1 双引号转义 | PASS | esc 已处理双引号，属性文本不破坏 HTML |
| B2 统一折叠 / gap / 收起 | 局部 PASS | 未归属记录已走同一折叠，expandedZones 控制收起；但只挑前三张会丢掉修改/验证路径，产品整体未过 |
| B3 边等级与直接关系 | 局部 PASS | 默认 main 按障碍状态，直接端点谓词已替换；仍无箭头、跨列避障和折叠关系，真实概览仅1条可见边 |
| B4 区域框 / 颜色 | PASS | zone left/right、uns选择器、dim均已修改；这不证明所有字体放大/透明度组合通过 |
| B5 历史与抽屉 | FAIL | 前端atOrBefore和renderDrawer已修，但后端仍把新正文覆盖旧正文，且tick写入比stamp早1；不能声称历史真实 |
| B6 键盘与隐藏面板 | 局部 PASS | 详情Enter过滤、折叠原生按钮与隐藏抽屉已修；轮询移除焦点的DOM仍失败 |

真实快照浏览器读数：1920×1080、scrollWidth1920、无卡内溢出；目标左边788px且与折叠入口重叠；同一版本5秒轮询后焦点从c-GOAL消失。

来源：`/tmp/observe-acceptance/baseline.json`、`baseline.png`。后端原函数反例：`/tmp/observe-backend-audit.md`。

## 结论

不批准把658ecff写成整体验收通过。沿findings.md修复，不回滚已正确落地的转义、折叠计数集合与按时点取值保护。
