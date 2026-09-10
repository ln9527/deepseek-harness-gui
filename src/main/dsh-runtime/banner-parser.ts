/**
 * ★上游耦合点:DSH stdout 就绪行解析。
 * 上游在 Loader settle 后打印 `dsh web: http://127.0.0.1:<port>`(可能带 LAN 后缀)。
 * 0.1.5 起 URL 带 `?token=…`:DSH 的 web fence 要求携带 token 访问,
 * 壳必须把整条 URL(含 query)loadURL 进窗口,否则显示「dsh web authentication required」。
 * 三层降级:严格前缀 → 宽松 URL 捕获 → 不匹配(交由看门狗判失败)。
 * 纯函数,无状态。
 */

const STRICT_BANNER = /^dsh web: http:\/\/127\.0\.0\.1:(\d+)/
const LOOSE_BANNER = /http:\/\/127\.0\.0\.1:(\d+)/

/** 就绪行里的完整本机 URL(含 ?token=… 等 query);不匹配时 null。 */
const FULL_URL = /http:\/\/127\.0\.0\.1:\d+[^\s]*/

export function parseBannerPort(line: string): number | null {
  const match = STRICT_BANNER.exec(line) ?? LOOSE_BANNER.exec(line)
  if (!match || match[1] === undefined) {
    return null
  }
  const port = Number.parseInt(match[1], 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

export function parseBannerUrl(line: string): string | null {
  if (parseBannerPort(line) === null) {
    return null
  }
  return FULL_URL.exec(line)?.[0] ?? null
}
