/** 定容环形缓冲:保存 stdout/stderr 尾部与日志尾部(纯数据结构,可测)。 */

export interface RingBuffer<T> {
  readonly capacity: number
  readonly size: number
  push(item: T): void
  clear(): void
  items(): readonly T[]
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (capacity < 1) {
    throw new Error(`ring buffer capacity must be >= 1, got ${capacity}`)
  }
  const buffer: T[] = []
  return {
    capacity,
    get size(): number {
      return buffer.length
    },
    push(item: T): void {
      buffer.push(item)
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity)
      }
    },
    clear(): void {
      buffer.splice(0, buffer.length)
    },
    items(): readonly T[] {
      return [...buffer]
    }
  }
}
