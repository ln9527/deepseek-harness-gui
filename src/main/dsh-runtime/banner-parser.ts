/**
 * ★上游耦合点:DSH stdout 就绪行解析。
 * 上游在 Loader settle 后打印 `dsh web: http://127.0.0.1:<port>`(可能带 LAN 后缀)。
 * 三层降级:严格前缀 → 宽松 URL 捕获 → 不匹配(交由看门狗判失败)。
 * 纯函数,无状态。
 */

const STRICT_BANNER = /^dsh web: http:\/\/127\.0\.0\.1:(\d+)/
const LOOSE_BANNER = /http:\/\/127\.0\.0\.1:(\d+)/

export function parseBannerPort(line: string): number | null {
  const match = STRICT_BANNER.exec(line) ?? LOOSE_BANNER.exec(line)
  if (!match || match[1] === undefined) {
    return null
  }
  const port = Number.parseInt(match[1], 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}
