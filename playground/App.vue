<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue";
import { ImageStudio } from "vue-inpaint-canvas";
import type { StudioResult } from "vue-inpaint-canvas";

const source = shallowRef<HTMLCanvasElement>();
const info = ref("");
const imageUrl = ref("");
const maskUrl = ref("");

onMounted(() => {
  // 造一张测试图（彩色渐变 + 网格），等价 PoC 的可控基准。
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 512, 512);
  g.addColorStop(0, "#1d9e75");
  g.addColorStop(0.5, "#378add");
  g.addColorStop(1, "#d4537e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  // 非对称标记：左上角红块 + 右下角黄块，让旋转/翻转一眼可辨。
  ctx.fillStyle = "#ff3b3b";
  ctx.fillRect(8, 8, 96, 96);
  ctx.fillStyle = "#ffd23b";
  ctx.fillRect(512 - 104, 512 - 104, 96, 96);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 28px system-ui";
  ctx.fillText("TL", 30, 64);
  source.value = c;
});

function onApply(r: StudioResult) {
  info.value = `image ${r.width}×${r.height} · mask ${r.hasMask ? "有" : "无"} · 覆盖 ${(r.maskCoverage * 100).toFixed(1)}%`;
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  if (maskUrl.value) URL.revokeObjectURL(maskUrl.value);
  imageUrl.value = URL.createObjectURL(r.image);
  maskUrl.value = r.mask ? URL.createObjectURL(r.mask) : "";
}
</script>

<template>
  <div class="wrap">
    <h1>vue-inpaint-canvas · playground</h1>
    <p class="sub">在画布涂抹要重绘的区域 → 点「应用」→ 下方查看导出的 image 与透明 mask。</p>
    <ImageStudio
      v-if="source"
      :source="source"
      :tools="['brush', 'eraser', 'rect', 'rotate', 'flip', 'crop', 'adjust']"
      @apply="onApply"
    />
    <p v-if="info" class="info">{{ info }}</p>
    <div class="previews">
      <figure v-if="imageUrl">
        <figcaption>image</figcaption>
        <img :src="imageUrl" alt="exported image" />
      </figure>
      <figure v-if="maskUrl">
        <figcaption>mask（棋盘 = 透明 = 要重绘）</figcaption>
        <img class="checker" :src="maskUrl" alt="exported mask" />
      </figure>
    </div>
  </div>
</template>

<style>
body {
  margin: 0;
}
.wrap {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
  color: #e8e8ea;
  font-family: system-ui, sans-serif;
}
.wrap h1 {
  font-size: 20px;
}
.sub {
  color: #9c9ca8;
  font-size: 14px;
}
.info {
  margin-top: 16px;
  color: #5dcaa5;
  font-size: 13px;
}
.previews {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.previews figcaption {
  font-size: 12px;
  color: #9c9ca8;
  margin-bottom: 6px;
}
.previews img {
  width: 240px;
  border-radius: 8px;
  display: block;
}
.checker {
  background-image: linear-gradient(45deg, #555 25%, transparent 25%),
    linear-gradient(-45deg, #555 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #555 75%),
    linear-gradient(-45deg, transparent 75%, #555 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-color: #888;
}
</style>
