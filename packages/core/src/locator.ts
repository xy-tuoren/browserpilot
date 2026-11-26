import type { BoundingBox } from '@browserpilot/protocol'
import {
  countLocatorMatches,
  queryLocator,
  STABLE_LOCATOR_FUNCTION,
  type LocatorQueryResult,
  type LocatorVisibilityMode,
} from './locator/evaluator.js'
import { splitLocatorChain } from './locator/parser.js'
import type { ClickOptions, FillOptions, PageController, ScreenshotOptions } from './page-controller.js'

export {
  countLocatorMatches,
  queryLocator,
  splitLocatorChain,
  STABLE_LOCATOR_FUNCTION,
  type LocatorQueryResult,
  type LocatorVisibilityMode,
}

/**
 * Fluent, immutable Playwright-compatible Locator object backed by BrowserPilot's pure-CDP engine.
 * Example: `locator('.card').filter({ hasText: 'Pro' }).locator('role=button[name="Buy"]').first().click()`
 */
export class Locator {
  readonly selector: string
  private readonly page: PageController

  constructor(page: PageController, selector: string) {
    this.page = page
    this.selector = selector.trim()
  }

  locator(subSelector: string): Locator {
    return new Locator(this.page, `${this.selector} >> ${subSelector.trim()}`)
  }

  filter(options: { hasText?: string | RegExp; has?: string | Locator; visible?: boolean }): Locator {
    const parts = [this.selector]
    if (options.hasText !== undefined) {
      const val = options.hasText instanceof RegExp ? options.hasText.toString() : JSON.stringify(options.hasText)
      parts.push(`has-text=${val}`)
    }
    if (options.has !== undefined) {
      const sub = options.has instanceof Locator ? options.has.selector : options.has
      parts.push(`has=${sub}`)
    }
    if (options.visible !== undefined) {
      parts.push(`visible=${options.visible ? 'true' : 'false'}`)
    }
    return new Locator(this.page, parts.join(' >> '))
  }

  first(): Locator {
    return new Locator(this.page, `${this.selector} >> first`)
  }

  last(): Locator {
    return new Locator(this.page, `${this.selector} >> last`)
  }

  nth(index: number): Locator {
    return new Locator(this.page, `${this.selector} >> nth=${index}`)
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.page.click(this.selector, options)
  }

  async dblclick(): Promise<void> {
    await this.page.dblclick(this.selector)
  }

  async rightClick(): Promise<void> {
    await this.page.rightClick(this.selector)
  }

  async hover(timeoutMs?: number): Promise<void> {
    await this.page.hover(this.selector, timeoutMs)
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    await this.page.fill(this.selector, value, options)
  }

  async type(text: string, options?: { delayMs?: number }): Promise<void> {
    await this.page.type(this.selector, text, options)
  }

  async check(options?: { timeoutMs?: number; force?: boolean }): Promise<boolean> {
    return await this.page.check(this.selector, options)
  }

  async uncheck(options?: { timeoutMs?: number; force?: boolean }): Promise<boolean> {
    return await this.page.uncheck(this.selector, options)
  }

  async selectOption(valueOrLabels: string | string[]): Promise<string[]> {
    return await this.page.selectOption(this.selector, valueOrLabels)
  }

  async uploadFiles(filePaths: string[]): Promise<void> {
    await this.page.uploadFiles(this.selector, filePaths)
  }

  async dragTo(target: string | Locator | { x: number; y: number }, options?: { steps?: number }): Promise<void> {
    const dest = target instanceof Locator ? target.selector : target
    await this.page.drag(this.selector, dest, options)
  }

  async scrollIntoView(): Promise<void> {
    await this.page.resolveElement(this.selector)
  }

  async waitFor(
    options: { state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeoutMs?: number } = {},
  ): Promise<boolean> {
    return await this.page.waitForLocator(this.selector, options)
  }

  async count(): Promise<number> {
    return await countLocatorMatches(this.page.session, this.selector, { visibilityMode: 'prefer-visible' })
  }

  async isVisible(): Promise<boolean> {
    return (await countLocatorMatches(this.page.session, this.selector, { visibilityMode: 'visible-only' })) > 0
  }

  async isEnabled(): Promise<boolean> {
    return await this.page.readElementProperty<boolean>(
      this.selector,
      `function() { return !(this.disabled === true || this.getAttribute?.('aria-disabled') === 'true'); }`,
    )
  }

  async isChecked(): Promise<boolean> {
    return await this.page.readElementProperty<boolean>(
      this.selector,
      `function() { return Boolean(this.checked || this.getAttribute?.('aria-checked') === 'true'); }`,
    )
  }

  async textContent(): Promise<string> {
    return await this.page.readElementProperty<string>(this.selector, `function() { return this.textContent ?? ''; }`)
  }

  async innerText(): Promise<string> {
    return await this.page.readElementProperty<string>(
      this.selector,
      `function() { return this.innerText ?? this.textContent ?? ''; }`,
    )
  }

  async inputValue(): Promise<string> {
    return await this.page.readElementProperty<string>(
      this.selector,
      `function() { return this.isContentEditable ? (this.innerText ?? '') : (this.value ?? ''); }`,
    )
  }

  async getAttribute(name: string): Promise<string | null> {
    return await this.page.readElementProperty<string | null>(
      this.selector,
      `function() { return this.getAttribute(${JSON.stringify(name)}); }`,
    )
  }

  async boundingBox(): Promise<BoundingBox> {
    const el = await this.page.resolveElement(this.selector)
    return el.box
  }

  async getLocatorString(): Promise<string> {
    return await this.page.getLocatorString(this.selector)
  }

  async screenshot(options: Omit<ScreenshotOptions, 'clip' | 'fullPage'> = {}) {
    const el = await this.page.resolveElement(this.selector)
    return await this.page.screenshot({
      ...options,
      zoom: {
        x: Math.max(0, Math.round(el.box.x)),
        y: Math.max(0, Math.round(el.box.y)),
        width: Math.max(1, Math.round(el.box.width)),
        height: Math.max(1, Math.round(el.box.height)),
        scale: options.zoom?.scale ?? 1,
      },
    })
  }
}
