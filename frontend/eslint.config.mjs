// ESLint 扁平配置（ESLint 9 / typescript-eslint 8）
//
// 定位：这是"逐步收敛"的起点，不是一次性归零。存量代码里有许多既有写法，
// 因此会触发大量告警的规则先降到 warn —— 先让 linter 能跑起来并被 CI 引用，
// 再按模块逐步收紧。不要把 warn 直接改成 error，否则会一次性产生上千条失败。
//
// 注意：full-repo 格式化请勿直接执行 `npm run format`，那会把 App.tsx（18k 行）
// 等大文件的 diff 淹没。只对新文件或本次改动过的文件跑 prettier。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.config.js",
      "*.config.d.ts",
      // 备份文件/构建产物（正常已被 .gitignore 覆盖，此处兜底）
      "**/*.bak-*",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- 渲染进程源码（TS/TSX）----
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // hooks 规则是真正的正确性问题，保持 error
      "react-hooks/rules-of-hooks": "error",
      // 依赖数组：存量 238 个 useCallback，先 warn 观察
      "react-hooks/exhaustive-deps": "warn",

      // 存量债：先 warn，随重构逐步收敛到 error
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",

      // TS 已负责未定义标识符检查，交给 tsc
      "no-undef": "off",
    },
  },

  // ---- Electron 主进程 / preload / 脚本（CommonJS）----
  {
    files: ["electron/**/*.cjs", "scripts/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        structuredClone: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "prefer-const": "warn",
      // .cjs 是 CommonJS，require() 是正确写法，不该按 ESM 规则报错
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      // Node CJS 全局很多，交给运行时；这里不做 no-undef 检查
      "no-undef": "off",
    },
  },
);
