// main.js — 最小接入示例
//
// 展示如何接入 update-kit：
//   1. 调用 updateKit.init
//   2. 创建窗口
//   3. 绑定窗口 + 启动调度器
'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const updateKit = require('../../host/main-host');

let win = null;

app.whenReady().then(async () => {
  const kit = await updateKit.init({
    projectRoot: __dirname,
    kitDir: path.resolve(__dirname, '../..'),
    electron: { app, BrowserWindow, ipcMain, dialog },
    getWindow: () => win,
    logger: console,
  });

  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: kit.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  kit.attach(win);
  win.loadFile(kit.appEntryPath);
  kit.startScheduler();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
