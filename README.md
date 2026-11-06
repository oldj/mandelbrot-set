# Mandelbrot Canvas

一个只有全屏 Canvas 的单页静态站点，使用 TypeScript 和 Vite，没有前端框架或服务端依赖。

## 本地运行

```sh
npm install
npm run dev
```

## VS Code 启动

安装依赖后，用 VS Code 打开项目根目录，选择「dev」配置并按 F5，即可在终端启动 `npm run dev`。浏览器由你自行打开，访问终端显示的地址（当前为 `http://127.0.0.1:59472/`）。

开发端口使用 `package.json` 中的配置。启动前，请先停止手动运行的同项目开发服务器，避免端口冲突。

## 构建与预览

```sh
npm run build
npm run preview
```

将 `dist/` 目录部署到静态托管服务即可。

Canvas 根据窗口大小和屏幕像素密度重新绘制，保持复平面的横纵比例，并始终完整显示集合。Web Worker 计算迭代与平滑着色，分块传回像素，避免阻塞页面主线程。像素密度最高为 2 倍，迭代上限为 800。

配色与迭代上限位于 `src/mandelbrot.worker.ts`；页面尺寸样式位于 `src/style.css`。
