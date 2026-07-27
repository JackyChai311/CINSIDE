const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find the useEffect that ends around line 644 (now shifted by 7 lines from insert)
// Let's find a useEffect with "selectMode" in dependency array
for (let i = 630; i < 700; i++) {
  console.log(i + 1, lines[i]);
}
