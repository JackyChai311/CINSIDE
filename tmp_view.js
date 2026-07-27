const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");
for (let i = 490; i < 530; i++) {
  console.log(i + 1, lines[i]);
}
