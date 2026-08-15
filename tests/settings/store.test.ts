import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/store'
import { defaultShellSettings } from '../../src/shared/settings'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-settings-'))
  tmpDirs.push(dir)
  return join(dir, 'settings.json')
}

describe('SettingsStore', () => {
  it('无文件 → 默认值', () => {
    const store = new SettingsStore(makeStorePath())
    expect(store.get()).toEqual(defaultShellSettings)
  })

  it('损坏 JSON → 隔离为 .bak 并回落默认(不抛)', () => {
    const path = makeStorePath()
    writeFileSync(path, '{ not valid json !!', 'utf8')
    const store = new SettingsStore(path)
    expect(store.get()).toEqual(defaultShellSettings)
    const bak = readdirSync(join(path, '..')).filter((f) => f.startsWith('settings.json.bak-'))
    expect(bak.length).toBe(1)
  })

  it('schema 不符 → 同样隔离回落', () => {
    const path = makeStorePath()
    writeFileSync(path, JSON.stringify({ pinnedVersion: 42 }), 'utf8')
    const store = new SettingsStore(path)
    expect(store.get()).toEqual(defaultShellSettings)
  })

  it('update 持久化且新实例可读回;对象被冻结', () => {
    const path = makeStorePath()
    const store = new SettingsStore(path)
    const next = store.update({ notifications: { approvals: false }, pinnedVersion: '0.1.0-rc.6' })
    expect(next.notifications.approvals).toBe(false)
    expect(next.pinnedVersion).toBe('0.1.0-rc.6')
    expect(Object.isFrozen(next)).toBe(true)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as { pinnedVersion: string }
    expect(persisted.pinnedVersion).toBe('0.1.0-rc.6')
    const reopened = new SettingsStore(path)
    expect(reopened.get().notifications.approvals).toBe(false)
  })

  it('patch 不携带的段落保持原值(不可变合并)', () => {
    const store = new SettingsStore(makeStorePath())
    const before = store.get()
    const after = store.update({ autoRestart: false })
    expect(after.autoRestart).toBe(false)
    expect(after.notifications).toEqual(before.notifications)
    expect(after.window).toEqual(before.window)
  })

  it('订阅广播在 update 后触发', () => {
    const store = new SettingsStore(makeStorePath())
    const seen: boolean[] = []
    store.subscribe((s) => {
      seen.push(s.autoRestart)
    })
    store.update({ autoRestart: false })
    expect(seen).toEqual([false])
  })

  it('旧格式(无 flags 段)兼容:不触发隔离回落,flags 补默认值', () => {
    const path = makeStorePath()
    const legacy = JSON.parse(JSON.stringify(defaultShellSettings)) as Record<string, unknown>
    delete legacy.flags
    legacy.autoRestart = false
    writeFileSync(path, JSON.stringify(legacy), 'utf8')
    const store = new SettingsStore(path)
    expect(store.get().flags).toEqual({ apiKeyPromptSeen: false })
    expect(store.get().autoRestart).toBe(false)
    // 未被隔离成 .bak
    const bak = readdirSync(join(path, '..')).filter((f) => f.includes('.bak-'))
    expect(bak).toEqual([])
  })

  it('flags 更新持久化且其余段原值;对象冻结', () => {
    const path = makeStorePath()
    const store = new SettingsStore(path)
    const next = store.update({ flags: { apiKeyPromptSeen: true } })
    expect(next.flags.apiKeyPromptSeen).toBe(true)
    expect(next.notifications).toEqual(defaultShellSettings.notifications)
    expect(Object.isFrozen(next.flags)).toBe(true)
    const reopened = new SettingsStore(path)
    expect(reopened.get().flags.apiKeyPromptSeen).toBe(true)
  })

  it('写入是原子的(不留 .tmp 残留)', () => {
    const path = makeStorePath()
    const store = new SettingsStore(path)
    store.update({ autoRestart: true })
    const leftovers = readdirSync(join(path, '..')).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
    expect(existsSync(path)).toBe(true)
  })
})
