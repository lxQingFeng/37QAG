# 37QAG 阶段四·三套 UI 风格集成说明（v0.6.0）

> 原型：ui/designs/（A 素笺 / B 深空控制台 / C 暖房，设计匠人产出）。
> 结果：**134/134 测试全绿**（133 + apply 落盘回归 1），颜色 token 100% 与原型一致（独立复核），形态层按 data-ui-style 机制扩展。

---

## 一、切换方式（用户视角）

**设置 → 桌面端 → 界面 → 主题预设卡**：列表从 4 张变 7 张（新增「素笺 / 深空控制台 / 暖房」），点一下即整套生效：
- 颜色：走现有「导入主题」通道（themes/ 内置层收录，/api/themes 自动列出）
- 形态：data-ui-style 机制（与机甲/女仆/像素完全同款）——衬线标题/等宽 HUD/药丸圆角等随主题切换

主题 id → 形态映射：`sujian-paper → sujian`、`deep-space-console → deepspace`、`warm-room → warmroom`（别名 sujian/deepspace/warmroom 也认）。
桌面端与 Web UI 共用 ui/（Electron 与 server 静态层同源），一次集成双端生效（测试断言 index.html/app.js/style.css 引用链）。

## 二、实现落点

| 文件 | 改动 |
|---|---|
| themes/*.json ×3 | 内置主题层新增（listThemes 双层读取自动收录） |
| ui/app.js | 3 个 UI_IDS 集合 + 3 个预设常量（与 theme.json 逐色一致，测试防漂移）+ applyCustomColors/syncThemeStyle/loadThemePresets/主题卡 fallback 共 5 处扩展（浅色素笺/暖房与深色深空各自的 token 锁定策略，防 customText 改坏） |
| ui/style.css | 三段形态：素笺（衬线标题+朱砂印+纸感阴影）/ 深空（等宽标签+扫描线+角括号+发光选中）/ 暖房（药丸圆角+暖渐变主按钮+内高光） |
| modules/themes/impl.js | FILE_BUILTIN_IDS 磁盘内置白名单：migrateUserThemesOut 不再把新内置主题误搬 data/themes/（本轮踩到并修复） |
| modules/themes/index.js | **修复阶段二遗留 bug**：apply/import 路由误写模块私有段（config.modules.themes.ui）而非全局 ui——表现为「应用主题返回 ok 但配置不落盘」。已改用全局 updateConfig，补回归测试 |

## 三、与原型的差异说明（如实）

**颜色系统：零差异**——三份 theme.json 的 8 色与原型 :root 逐一相等（测试独立复核了设计匠人的 README 声明）。

**形态层：按「提炼签名特征 → 映射到现有选择器面」集成，有以下取舍**：

| 原型细节 | 集成处理 | 原因 |
|---|---|---|
| A：朱丝栏页面边线（信笺红细边框） | 未移植 | 真实 UI 页面结构更复杂（多视图滚动），整页边框装饰与长列表滚动冲突；改为区块标题前 7px 朱砂方印（同语义） |
| B：runstate 卡四角 HUD 括号 | 简化为选中项两角（左上+右下） | 真实会话卡片高度比原型运行卡矮，四角括号视觉密度过高 |
| B：tab 激活发光下划线 | 映射为 session-item 选中发光 | 真实 UI 无原型那排 tab，语义等价物是会话选中态 |
| C：圆形头像/圆角输入槽 | 由 .btn 等类级药丸圆角自然映射 | 原型元素级细节在真实类名体系下自动获得圆角 |
| 原型演示数据（冷却倒计时/秒表等） | 不涉及 | 是功能演示不是风格资产 |
| 亮度/缩放（原型内真实交互） | 走既有实现 | Electron zoomFactor/亮度已有，README 集成假设第 6 条 |

## 四、测试结果

```
npm test → 134/134（0 fail）      npm run check → PASS
新增 7 项（ui-styles-test.mjs）：
  1. 三份 theme.json 内置收录与颜色完整性
  2. app.js 预设 ↔ theme.json 逐色一致（跨文件防漂移）
  3. data-ui-style 机制五处扩展齐全（集合/分支/fallback）
  4. style.css 三段形态 + 签名特征（衬线/等宽/扫描线/角括号/药丸渐变）
  5. 双端同源（index.html 引用链 + Electron 加载 ui/）
  6. 视觉一致性：原型 :root 8 色 token 逐一复核
  7. apply 写全局 ui 段回归（阶段二私有段 bug 防再犯）
冒烟：7 主题列表 → apply sujian-paper → config 正确落盘（customThemeId/theme/customBg/customAccent）
```

## 五、视觉一致性自查记录

- token 级：8 色 × 3 套逐一相等（自动化断言）
- 形态级：签名特征逐项断言（衬线字体栈/mono 字体栈/扫描线渐变/角括号边框/药丸半径/暖渐变色值均来自原型原文）
- 未做：无头浏览器像素级截图回归（沙箱无浏览器截图链路）——以 token+结构断言替代，差异点已在上表如实列出
