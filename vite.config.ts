import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// dev（command === "serve"）跑根 index.html → playground；
// build 走 library mode 产出 dist/index.js（Vue）+ dist/core.js（框架无关核心）+ dist/style.css。
// 类型声明由 `vue-tsc -p tsconfig.build.json`（build 脚本第二步）生成到 dist/，无需 dts 插件。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "vue-inpaint-canvas": r("./src/vue/index.ts"),
      "vue-inpaint-canvas/core": r("./src/core/index.ts"),
    },
  },
  build: {
    lib: {
      entry: {
        index: r("./src/vue/index.ts"),
        core: r("./src/core/index.ts"),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // 宿主提供 vue/konva，不打进库。
      external: ["vue", "konva"],
      output: { assetFileNames: "style.css", chunkFileNames: "[name].js" },
    },
  },
  test: {
    // jsdom + devDep `canvas`(node-canvas) 让 document.createElement('canvas') 出真实像素，
    // 全链路 getContext/getImageData/toBlob 与 Konva.toCanvas() 可跑，无需 browser mode（DESIGN §9 方案 B）。
    environment: "jsdom",
    globals: true,
  },
});
