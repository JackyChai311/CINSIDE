const fs = require('fs');
const path = require('path');
const toIco = require('png-to-ico').default;

const pngs = [256, 128, 64, 48, 32, 16].map((s) =>
  path.join(__dirname, '..', 'assets', `icon-${s}.png`)
);

toIco(pngs)
  .then((buf) => {
    fs.writeFileSync(path.join(__dirname, '..', 'assets', 'cinside-icon.ico'), buf);
    console.log('ICO created');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
