// 渲染进程 ↔ 主进程桥。仅暴露 B 站登录相关，最小权限。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqAgent', {
  biliLogin: () => ipcRenderer.invoke('bili:login'),
  onBiliLoginStatus: (cb) => {
    const listener = (_e, status) => cb?.(status);
    ipcRenderer.on('bili:login-status', listener);
    return () => ipcRenderer.removeListener('bili:login-status', listener);
  },
  /** Windows titleBarOverlay：随主题改最小化/最大化/关闭图标颜色（兼容旧路径） */
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('ui:set-titlebar', opts),
  /** 自绘窗口控制：最小化 / 最大化 / 关闭（关闭仍走托盘逻辑） */
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  /** 界面缩放：Electron zoomFactor，整页（含 px 卡牌）等比放大 */
  setZoomFactor: (z) => ipcRenderer.invoke('ui:set-zoom', z),
  getZoomFactor: () => ipcRenderer.invoke('ui:get-zoom')
});
