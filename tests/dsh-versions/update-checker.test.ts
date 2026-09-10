import { describe, expect, it } from 'vitest'
import { checkForUpdate, isUpdateAvailable } from '../../src/main/dsh-versions/update-checker'

describe('isUpdateAvailable', () => {
  it('active 落后于 latest 时返回 true', () => {
    expect(isUpdateAvailable('0.1.0-rc.6', '0.1.2-rc.1')).toBe(true)
  })

  it('active 等于或领先于 latest 时返回 false', () => {
    expect(isUpdateAvailable('0.1.2-rc.1', '0.1.2-rc.1')).toBe(false)
    expect(isUpdateAvailable('0.1.3-alpha.2', '0.1.2-rc.1')).toBe(false)
  })

  it('未装版本不算有更新(那是首装)', () => {
    expect(isUpdateAvailable(null, '0.1.2-rc.1')).toBe(false)
  })

  it('latest 为空不算有更新(registry 异常的 fail-soft)', () => {
    expect(isUpdateAvailable('0.1.0-rc.6', '')).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('取 dist-tags.latest 与 active 比较', async () => {
    const result = await checkForUpdate({
      npm: { async listDistTags() { return { ok: true as const, value: { latest: '0.1.2-rc.1' } } } },
      activeVersion: '0.1.0-rc.6'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        latest: '0.1.2-rc.1',
        current: '0.1.0-rc.6',
        updateAvailable: true
      })
    }
  })

  it('channel=next 时取 next tag,通道缺 tag 回退 latest', async () => {
    const tags = { latest: '0.1.5-rc.1', next: '0.1.5-rc.2' }
    const mk = () => ({ async listDistTags() { return { ok: true as const, value: tags } } })
    const next = await checkForUpdate({ npm: mk(), activeVersion: '0.1.5-rc.1', channel: 'next' })
    expect(next.ok).toBe(true)
    if (next.ok) {
      expect(next.value.latest).toBe('0.1.5-rc.2')
      expect(next.value.updateAvailable).toBe(true)
    }
    const alpha = await checkForUpdate({ npm: mk(), activeVersion: '0.1.5-rc.1', channel: 'alpha' })
    expect(alpha.ok).toBe(true)
    if (alpha.ok) {
      expect(alpha.value.latest).toBe('0.1.5-rc.1')
      expect(alpha.value.updateAvailable).toBe(false)
    }
  })

  it('npm 失败时原样透传错误(fail-soft,不 throw)', async () => {
    const result = await checkForUpdate({
      npm: { async listDistTags() { return { ok: false as const, error: { code: 'npm-missing', message: 'npm 不可用' } } } },
      activeVersion: '0.1.0-rc.6'
    })
    expect(result.ok).toBe(false)
  })
})
