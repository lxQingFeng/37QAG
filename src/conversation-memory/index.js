// 门面：人类隐喻 ↔ 实现
//
//  长时     longterm.js    日块压缩分文件
//  海马     hippocampus.js 倒排索引 + 检索
//  巩固     consolidator.js messages → chunks → index
//  工具     tools.js       memory_search / memory_status
//
//  跨轮     cross-turn.js  本次运行小剪贴板
//
export { LongTermStore, dayKeyOf, formatWhen } from './longterm.js';
export { Hippocampus, buildHit } from './hippocampus.js';
export { Consolidator } from './consolidator.js';
export { createConversationMemory } from './tools.js';
export { tokenize, queryTokens, normText } from './tokenize.js';
export { SemanticCardStore } from './semantic-cards.js';
export { CrossTurnWorking } from './cross-turn.js';
export { buildCrossChatAwareness } from './cross-chat.js';
export { getArchMemory, buildArchitectureInject, saveCrossTurn } from './arch.js';
export { saveTodo, completeTodo, activeTodos, renderTodosForPrompt } from './pending.js';
export { reportRunCost, shouldReduceOptionalInjects, costGuardStats } from './cost-guard.js';
