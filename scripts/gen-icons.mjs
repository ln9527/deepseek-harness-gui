#!/usr/bin/env node
/**
 * 生成应用与托盘图标(零图像依赖:手写 PNG 编码 + 4x 超采样抗锯齿)。
 * 产出:
 *   build/icon.png                 1024×1024 应用图标(electron-builder 转 icns)
 *   resources/tray/readyTemplate.png / @2x     托盘"就绪"(黑 + alpha 模板图)
 *   resources/tray/stoppedTemplate.png / @2x   托盘"停止"
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** shape(x, y) ∈ 0..1 → bool;4×4 超采样得覆盖率(alpha)。 */
function render(size, shape, color) {
  const SS = 4
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
          if (shape(px, py)) {
            hit++
          }
        }
      }
      const alpha = Math.round((hit / (SS * SS)) * color[3])
      const i = (y * size + x) * 4
      rgba[i] = color[0]
      rgba[i + 1] = color[1]
      rgba[i + 2] = color[2]
      rgba[i + 3] = alpha
    }
  }
  return encodePng(size, size, rgba)
}

// ---- 形状 ----
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
const sub = (a, b) => (x, y) => a(x, y) && !b(x, y)
const union = (...shapes) => (x, y) => shapes.some((s) => s(x, y))
const roundRect = (margin, radius) => (x, y) => {
  if (x < margin || x > 1 - margin || y < margin || y > 1 - margin) {
    return false
  }
  const nx = Math.max(margin + radius - x, x - (1 - margin - radius), 0)
  const ny = Math.max(margin + radius - y, y - (1 - margin - radius), 0)
  return nx * nx + ny * ny <= radius * radius
}

// ---- 应用图标:蓝底圆角方 + 白色环 ----
const BLUE = [78, 110, 242, 255]
const WHITE = [255, 255, 255, 255]
const appShape = union(roundRect(0.04, 0.22), sub(circle(0.5, 0.5, 0.30), circle(0.5, 0.5, 0.185)))
const appIcon = render(1024, appShape, BLUE)
// 环形白色叠加:直接两遍渲染太麻烦 —— 改为单遍:底色随 shape 切换
// (render 单色限制下,用"底蓝 + 环白"两图合成)
function renderAppIcon() {
  const size = 1024
  const SS = 4
  const rgba = Buffer.alloc(size * size * 4)
  const bg = roundRect(0.04, 0.22)
  const ring = sub(circle(0.5, 0.5, 0.30), circle(0.5, 0.5, 0.185))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0
      let ringHit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
          if (bg(px, py)) {
            bgHit++
          }
          if (ring(px, py)) {
            ringHit++
          }
        }
      }
      const bgA = bgHit / (SS * SS)
      const ringA = ringHit / (SS * SS)
      const outA = Math.max(bgA, ringA)
      const i = (y * size + x) * 4
      // 环(白)按覆盖率叠在底(蓝)上
      const mix = (base, top, a) => Math.round(base * (1 - a) + top * a)
      rgba[i] = mix(BLUE[0], WHITE[0], ringA)
      rgba[i + 1] = mix(BLUE[1], WHITE[1], ringA)
      rgba[i + 2] = mix(BLUE[2], WHITE[2], ringA)
      rgba[i + 3] = Math.round(outA * 255)
    }
  }
  return encodePng(size, size, rgba)
}

// ---- 托盘模板图(macOS:黑 + alpha,命名 *Template.png 由系统着色;Windows:彩色普通 png) ----
const BLACK = [0, 0, 0, 255]
const ACCENT = [78, 110, 242, 255]
const readyShape = circle(0.5, 0.5, 0.34)
const stoppedShape = sub(circle(0.5, 0.5, 0.36), circle(0.5, 0.5, 0.22))

mkdirSync(join(root, 'build'), { recursive: true })
mkdirSync(join(root, 'resources', 'tray'), { recursive: true })

writeFileSync(join(root, 'build', 'icon.png'), renderAppIcon())
void appShape // (单色版本保留为参考,未使用)

for (const [name, shape] of [['ready', readyShape], ['stopped', stoppedShape]]) {
  writeFileSync(join(root, 'resources', 'tray', `${name}Template.png`), render(16, shape, BLACK))
  writeFileSync(join(root, 'resources', 'tray', `${name}Template@2x.png`), render(32, shape, BLACK))
  writeFileSync(join(root, 'resources', 'tray', `win-${name}.png`), render(32, shape, ACCENT))
}

console.log('icons generated: build/icon.png, resources/tray/*Template{,@2x}.png, resources/tray/win-*.png')
