import { GameApp } from './game/GameApp.js';

declare global {
  interface Window {
    __tankApp?: GameApp;
  }
}

const canvas = document.getElementById('stage');
const uiRoot = document.getElementById('ui-root');
if (!(canvas instanceof HTMLCanvasElement) || !uiRoot) {
  throw new Error('页面结构缺少 #stage 或 #ui-root');
}

const app = new GameApp(canvas, uiRoot);
app.start();

// 移动端：禁掉双击缩放与长按菜单，避免误触打断瞄准
document.addEventListener('gesturestart', (event) => event.preventDefault());
window.addEventListener('contextmenu', (event) => event.preventDefault());

// 自动化验收用的调试句柄
window.__tankApp = app;
