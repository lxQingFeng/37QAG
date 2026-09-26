      // ── [[command-gateway:manifest-fields]] 「指令前置」插件自动维护，不要手改这一段 ──
      commands,
      // 兼容旧写法：只认第一条（新代码请用 commands）
      command: commands[0] || null,
      intercept: normalizeIntercept(raw.intercept, id),
      settingsUi: normalizeSettingsUi(raw.settingsUi, id),
      // 对外公开的能力（给别的插件当 API 用）：0.3.1 的核心自带这一行，0.4.0 的核心没有，
      // 用展开补上 —— 审计据此区分"公开能力"与孤儿能力（见 README §7.1b）。
      ...(Array.isArray(raw.exposes)
        ? { exposes: asArray(raw.exposes).map((x) => String(x).trim()).filter((x) => x && capabilities.includes(x)) }
        : {}),
      // ── [[/command-gateway:manifest-fields]] ──
