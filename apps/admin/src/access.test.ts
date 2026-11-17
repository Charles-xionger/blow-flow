import { describe, expect, it } from 'vitest'
import { mayEnterAdmin } from './access'

describe('admin entry', () => {
  it('allows only an active administrator with a valid token', () => {
    expect(mayEnterAdmin('admin', 'active', false)).toBe(true)
    expect(mayEnterAdmin('user', 'active', false)).toBe(false)
    expect(mayEnterAdmin('admin', 'disabled', false)).toBe(false)
    expect(mayEnterAdmin('admin', 'active', true)).toBe(false)
  })
})
