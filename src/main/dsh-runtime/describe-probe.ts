/**
 * ★上游耦合点:POST /api/host.describe 二次确认。
 * 四象限协议的上行格式:`POST /api/<method>` body 为 client-request 信封,
 * 恒 HTTP 200,业务结果在 server-response 信封的 result 里。
 * 探测失败只记录日志,不影响状态机(banner 已是就绪判据)。
 */

import { z } from 'zod'
import type { Result } from '../../shared/contracts'
import { err, errFromUnknown, ok } from '../util/result'

const describeResponseSchema = z.object({
  type: z.literal('server-response'),
  result: z.object({
    ok: z.literal(true),
    value: z.object({ version: z.string() })
  })
})

export interface DescribeProbeResult {
  readonly version: string
}

export async function probeHostDescribe(
  port: number,
  opts: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {}
): Promise<Result<DescribeProbeResult>> {
  const doFetch = opts.fetchImpl ?? fetch
  const origin = `http://127.0.0.1:${port}`
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, opts.timeoutMs ?? 3000)
  try {
    const response = await doFetch(`${origin}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `dsh-gui-probe-${Date.now()}`,
        method: 'host.describe',
        payload: {}
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      return err('probe-http', `host.describe HTTP ${response.status}`)
    }
    const body: unknown = await response.json()
    const parsed = describeResponseSchema.safeParse(body)
    if (!parsed.success) {
      return err('probe-schema', 'host.describe 响应不符合协议形状(上游可能已变更)')
    }
    return ok({ version: parsed.data.result.value.version })
  } catch (error) {
    return errFromUnknown('probe-failed', error)
  } finally {
    clearTimeout(timer)
  }
}
