const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const toIco = require('png-to-ico').default;

const assetsDir = path.join(__dirname, '..', 'assets');
const publicDir = path.join(__dirname, 'public');
const svgPath = path.join(assetsDir, 'app-icon.svg');
const icoPath = path.join(assetsDir, 'app-icon.ico');
const sizes = [256, 128, 64, 48, 32, 16];

async function main() {
  const svgBuf = fs.readFileSync(svgPath);

  // 1. 从 SVG 生成各尺寸 PNG（contain 模式：保持比例，居中留白）
  for (const size of sizes) {
    await sharp(svgBuf, { density: 72 * (size / 16) })
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toFile(path.join(assetsDir, `icon-${size}.png`));
    console.log(`icon-${size}.png generated`);
  }

  // 2. 生成多尺寸 ICO（大图在前，Windows 优先选用）
  const pngs = sizes.map((s) => path.join(assetsDir, `icon-${s}.png`));
  const buf = await toIco(pngs);
  fs.writeFileSync(icoPath, buf);
  console.log(`${path.basename(icoPath)} created`);

  // 3. 复制 256px PNG 到 public 目录（用于前端 <img> 标签，避免 ICO 渲染问题）
  fs.copyFileSync(
    path.join(assetsDir, 'icon-256.png'),
    path.join(publicDir, 'app-icon.png')
  );
  console.log('app-icon.png copied to public/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
