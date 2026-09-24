/** Narrow, read-only adapter for the bundled DSH 0.1.5-rc.2 Session RPCs. */
import { z } from 'zod'

const summarySchema = z.object({
  sessionId: z.string().min(1),
  updatedAt: z.number(),
  running: z.boolean(),
  origin: z.string().optional(),
  projections: z.object({ asOfSeq: z.number().int().min(-1) }).optional()
})
const listSchema = z.object({ items: z.array(summarySchema) })
const recordSchema = z.object({
  type: z.literal('event'),
  event: z.object({ type: z.string(), seq: z.number().int().min(0), time: z.number(), data: z.unknown() })
})
const pageSchema = z.object({ records: z.array(recordSchema), hasMore: z.boolean() })
const askedSchema = z.object({ id: z.string().min(1), toolName: z.string().min(1), reason: z.string().optional() })
const decidedSchema = z.object({ id: z.string().min(1), outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']) })
const turnStartSchema = z.object({ turn: z.number().int().min(0) })
const turnEndSchema = z.object({
  turn: z.number().int().min(0),
  reason: z.object({ kind: z.string().min(1), error: z.object({ message: z.string() }).optional() })
})

export type SessionSummary = z.infer<typeof summarySchema>
export type SessionRecord = z.infer<typeof recordSchema>['event']
export type SessionPage = z.infer<typeof pageSchema>
export type BridgeSignal =
  | { readonly kind: 'approval-requested'; readonly sessionId: string; readonly approvalId: string; readonly toolName: string; readonly reason: string | null }
  | { readonly kind: 'approval-resolved'; readonly sessionId: string; readonly approvalId: string }
  | { readonly kind: 'turn-ended'; readonly sessionId: string; readonly reason: string; readonly errorMessage: string | null }
  | { readonly kind: 'observer-error'; readonly sessionId: string }

export type NotifyEvent =
  | { readonly kind: 'approval-asked'; readonly id: string; readonly toolName: string; readonly reason: string | null }
  | { readonly kind: 'approval-decided'; readonly id: string }
  | { readonly kind: 'turn-started' }
  | { readonly kind: 'turn-ended'; readonly reason: string; readonly errorMessage: string | null }
  | { readonly kind: 'other' }

export function parseSessionList(value: unknown): readonly SessionSummary[] { return listSchema.parse(value).items }
export function parseSessionPage(value: unknown): SessionPage { return pageSchema.parse(value) }

/** Throw on a malformed event we rely on; don't silently skip a pending approval. */
export function parseNotifyEvent(event: SessionRecord): NotifyEvent {
  switch (event.type) {
    case 'approval/asked': {
      const data = askedSchema.parse(event.data)
      return { kind: 'approval-asked', id: data.id, toolName: data.toolName, reason: data.reason ?? null }
    }
    case 'approval/decided': return { kind: 'approval-decided', id: decidedSchema.parse(event.data).id }
    case 'turn/start': turnStartSchema.parse(event.data); return { kind: 'turn-started' }
    case 'turn/end': {
      const data = turnEndSchema.parse(event.data)
      return { kind: 'turn-ended', reason: data.reason.kind, errorMessage: data.reason.error?.message ?? null }
    }
    default: return { kind: 'other' }
  }
}
