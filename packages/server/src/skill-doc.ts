import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __BROWSERPILOT_SKILL_MD__: string | undefined

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').trim() + '\n'
}

function loadSkillDoc(): string {
  if (typeof __BROWSERPILOT_SKILL_MD__ === 'string' && __BROWSERPILOT_SKILL_MD__.length > 0) {
    return stripFrontmatter(__BROWSERPILOT_SKILL_MD__)
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.resolve(here, '..', '..', '..', 'skills', 'browserpilot', 'SKILL.md'),
      path.resolve(here, '..', '..', 'skills', 'browserpilot', 'SKILL.md'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return stripFrontmatter(fs.readFileSync(candidate, 'utf8'))
      }
    }
  } catch {
    // ignore fallback read errors
  }
  return '# BrowserPilot — Real Chrome Automation & DevTools Guide\n'
}

export const BROWSERPILOT_SKILL_DOC = loadSkillDoc()
