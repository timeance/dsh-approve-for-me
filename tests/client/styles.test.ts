import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const stylesheet = new URL(
  '../../src/client/ApproveForMeSettingsSection.module.css',
  import.meta.url,
)

function rule(source: string, selector: string): string {
  const selectorStart = source.lastIndexOf('\n.' + selector + ' {')
  const bodyStart = source.indexOf('{', selectorStart) + 1
  const bodyEnd = source.indexOf('}', bodyStart)
  if (selectorStart < 0 || bodyStart === 0 || bodyEnd < 0) {
    throw new Error('missing CSS rule: .' + selector)
  }
  return source.slice(bodyStart, bodyEnd)
}

describe('DSH semantic color contracts', () => {
  it('uses the official primary Button tokens', async () => {
    const source = await readFile(stylesheet, 'utf8')
    const button = rule(source, 'button')

    expect(button).toContain('background: var(--dsw-alias-button-primary-fill)')
    expect(button).toContain('color: var(--dsw-alias-label-primary-foreground)')
    expect(button).not.toContain('state-business-primary')
    expect(button).not.toContain('#fff')
  })

  it('keeps semantic surfaces while using readable body text', async () => {
    const source = await readFile(stylesheet, 'utf8')
    const error = rule(source, 'error')
    const success = rule(source, 'success')

    expect(error).toContain('state-error-primary')
    expect(error).toContain('border-color: var(--dsw-alias-state-error-secondary)')
    expect(error).toContain('color: var(--dsw-alias-label-primary)')
    expect(success).toContain('background: var(--dsw-alias-state-success-tertiary)')
    expect(success).toContain('border-color: var(--dsw-alias-state-success-secondary)')
    expect(success).toContain('color: var(--dsw-alias-label-primary)')
  })
})
