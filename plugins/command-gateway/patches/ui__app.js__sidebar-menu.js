  // ── [[command-gateway:sidebar-menu]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件自带设置页（清单里声明了 settingsUi 的插件）的侧栏入口。
  //
  // ⚠️ 这个变量在各核心版本里**形状不同**（2026-09-23 实测踩到）：
  //   · 0.3.1 / 0.4.0：`menu`        —— 平铺数组 [[key, label], …]
  //   · 京玉版：        `menuGroups` —— 分组数组 [[组名, [[key, label], …]], …]
  //   上一版写死了 `menu.push(...)`，在京玉版上直接 ReferenceError，
  //   把整个设置页的渲染打断（症状：设置页整片空白）。
  //   现在两个都认；**两个都不在**（上游又改结构）就什么都不做 ——
  //   宁可少一个入口，也绝不能因为这一句把设置页搞挂。
  const __cgPluginItems = pluginSections().map((p) => [p.key, p.label]);
  if (__cgPluginItems.length) {
    if (typeof menuGroups !== 'undefined' && Array.isArray(menuGroups)) {
      menuGroups.push(['插件', __cgPluginItems]);          // 京玉版：追加一个「插件」分组
    } else if (typeof menu !== 'undefined' && Array.isArray(menu)) {
      menu.push(...__cgPluginItems);                       // 0.3.1 / 0.4.0：追加到平铺菜单
    }
  }
  // ── [[/command-gateway:sidebar-menu]] ──
