/**
 * ★上游耦合点:WS 下行帧的两级宽校验(fail-soft 的契约边界)。
 * 第一级只锚定 server-request 信封形状;第二级只 narrow 壳关心的 4 种
 * payload(字段名与 DSH 源码 packages/host/apiproxy/src/api/events.ts 对齐)。
 * 任何解析失败一律返回 ignored —— 桥绝不因协议漂移而崩。
 */

import { z } from 'zod'

const serverRequestFrameSchema = z.object({
  type: z.literal('server-request'),
  rpcId: z.string(),
  method: z.string(),
  payload: z.unknown()
})

const approvalRequestedSchema = z.object({
  type: z.literal('approval/requested'),
  sessionId: z.string(),
  approvalId: z.string(),
  toolName: z.string(),
  callId: z.string().optional(),
  reason: z.string().optional()
})

const approvalResolvedSchema = z.object({
  type: z.literal('approval/resolved'),
  sessionId: z.string(),
  approvalId: z.string(),
  outcome: z.string()
})

const sessionStatusSchema = z.object({
  type: z.literal('host/session-status'),
  sessionId: z.string(),
  running: z.boolean()
})

const agentErrorSchema = z.object({
  type: z.literal('host/agent-error'),
  sessionId: z.string(),
  message: z.string()
})

export type BridgeSignal =
  | { readonly kind: 'approval-requested'; readonly sessionId: string; readonly approvalId: string; readonly toolName: string; readonly reason: string | null }
  | { readonly kind: 'approval-resolved'; readonly approvalId: string }
  | { readonly kind: 'session-status'; readonly sessionId: string; readonly running: boolean }
  | { readonly kind: 'agent-error'; readonly sessionId: string; readonly message: string }
  | { readonly kind: 'ignored'; readonly reason: IgnoredReason }

export type IgnoredReason = 'not-json' | 'not-server-request' | 'unknown-payload' | 'malformed-payload'

type PayloadKind = 'approval/requested' | 'approval/resolved' | 'host/session-status' | 'host/agent-error'

const KNOWN_PAYLOAD_TYPES: readonly PayloadKind[] = [
  'approval/requested',
  'approval/resolved',
  'host/session-status',
  'host/agent-error'
]

export function parseWsFrame(raw: string): BridgeSignal {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { kind: 'ignored', reason: 'not-json' }
  }
  const envelope = serverRequestFrameSchema.safeParse(json)
  if (!envelope.success) {
    return { kind: 'ignored', reason: 'not-server-request' }
  }
  const payload = envelope.data.payload
  if (payload === null || typeof payload !== 'object' || !('type' in payload)) {
    return { kind: 'ignored', reason: 'unknown-payload' }
  }
  const payloadType = (payload as { type: unknown }).type
  const isKnown = KNOWN_PAYLOAD_TYPES.some((k) => k === payloadType)
  if (!isKnown) {
    return { kind: 'ignored', reason: 'unknown-payload' }
  }
  const kind = payloadType as PayloadKind
  if (kind === 'approval/requested') {
    const parsed = approvalRequestedSchema.safeParse(payload)
    return parsed.success
      ? { kind: 'approval-requested', sessionId: parsed.data.sessionId, approvalId: parsed.data.approvalId, toolName: parsed.data.toolName, reason: parsed.data.reason ?? null }
      : { kind: 'ignored', reason: 'malformed-payload' }
  }
  if (kind === 'approval/resolved') {
    const parsed = approvalResolvedSchema.safeParse(payload)
    return parsed.success
      ? { kind: 'approval-resolved', approvalId: parsed.data.approvalId }
      : { kind: 'ignored', reason: 'malformed-payload' }
  }
  if (kind === 'host/session-status') {
    const parsed = sessionStatusSchema.safeParse(payload)
    return parsed.success
      ? { kind: 'session-status', sessionId: parsed.data.sessionId, running: parsed.data.running }
      : { kind: 'ignored', reason: 'malformed-payload' }
  }
  const parsed = agentErrorSchema.safeParse(payload)
  return parsed.success
    ? { kind: 'agent-error', sessionId: parsed.data.sessionId, message: parsed.data.message }
    : { kind: 'ignored', reason: 'malformed-payload' }
}
