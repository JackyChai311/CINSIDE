const fs = require("fs");
const p = "d:/CINSIDE/frontend/package.json";
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.build.publish = [
  {
    "provider": "github",
    "owner": "YOUR_GITHUB_USERNAME",
    "repo": "CINSIDE"
  }
];
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
console.log("package.json updated");
