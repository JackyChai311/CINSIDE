"use strict";
// 生成开发版图标：assets/app-icon-dev.svg → assets/app-icon-dev.ico
// 用 frontend 已有依赖 sharp（SVG→PNG 多尺寸）+ png-to-ico（多尺寸打包 ICO）。
// 用法：在 frontend 目录下执行 `node scripts/make-dev-icon.cjs`
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
// png-to-ico v3 是 ESM 包，CJS require 拿到 { __esModule, default, imagesToIco }，取 .default
const pngToIco = require("png-to-ico").default;

const SVG_PATH = path.join(__dirname, "../../assets/app-icon-dev.svg");
const ICO_PATH = path.join(__dirname, "../../assets/app-icon-dev.ico");

(async () => {
  const svg = fs.readFileSync(SVG_PATH);
  // 直接按目标尺寸渲染，避免先栅格化到 500px 再缩放丢失小尺寸清晰度
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(
    sizes.map((s) => sharp(svg, { density: 300 }).resize(s, s).png().toBuffer())
  );
  const ico = await pngToIco(pngs);
  fs.writeFileSync(ICO_PATH, ico);
  console.log(`[make-dev-icon] wrote ${ICO_PATH} (${ico.length} bytes, sizes=${sizes.join("/")})`);
})().catch((e) => {
  console.error("[make-dev-icon] failed:", e);
  process.exit(1);
});
