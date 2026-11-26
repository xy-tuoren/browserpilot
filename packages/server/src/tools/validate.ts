import type { ToolDefinition } from './types.js'

interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  enum?: unknown[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

const IMPLICIT_ROUTING_PROPERTIES: Record<string, JsonSchemaProperty> = {
  tabId: { type: 'number' },
  sessionId: { type: 'string' },
  clientId: { type: 'string' },
}

function coerceAndValidateValue(value: unknown, schema: JsonSchemaProperty, fieldPath: string): unknown {
  if (!schema.type) return value

  switch (schema.type) {
    case 'number': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error(`Invalid parameter "${fieldPath}": expected a finite number, got ${String(value)}`)
        }
        return value
      }
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.trim())
        if (Number.isFinite(parsed)) return parsed
      }
      throw new Error(
        `Invalid parameter "${fieldPath}": expected number, got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`,
      )
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      throw new Error(
        `Invalid parameter "${fieldPath}": expected boolean, got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`,
      )
    }

    case 'string': {
      let strVal: string
      if (typeof value === 'string') {
        strVal = value
      } else if ((typeof value === 'number' || typeof value === 'boolean') && !schema.enum) {
        strVal = String(value)
      } else {
        throw new Error(`Invalid parameter "${fieldPath}": expected string, got ${typeof value}`)
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(strVal)) {
        throw new Error(
          `Invalid parameter "${fieldPath}": got ${JSON.stringify(strVal)}, expected one of [${schema.enum.join(', ')}]`,
        )
      }
      return strVal
    }

    case 'array': {
      if (!Array.isArray(value)) {
        throw new Error(`Invalid parameter "${fieldPath}": expected array, got ${typeof value}`)
      }
      if (!schema.items) return value
      return value.map((item, idx) => coerceAndValidateValue(item, schema.items!, `${fieldPath}[${idx}]`))
    }

    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
          `Invalid parameter "${fieldPath}": expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
        )
      }
      return validateObjectAgainstSchema(value as Record<string, unknown>, schema, fieldPath)
    }

    default:
      return value
  }
}

function validateObjectAgainstSchema(
  rawObj: Record<string, unknown>,
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: string[] },
  prefix = '',
  includeImplicitRouting = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const declaredProps = schema.properties ?? {}

  if (Array.isArray(schema.required)) {
    for (const reqKey of schema.required) {
      const val = rawObj[reqKey]
      if (val === undefined || val === null) {
        const fullKey = prefix ? `${prefix}.${reqKey}` : reqKey
        throw new Error(`Missing required parameter "${fullKey}"`)
      }
    }
  }

  for (const [key, rawVal] of Object.entries(rawObj)) {
    if (rawVal === undefined) continue
    const propSchema = declaredProps[key] ?? (includeImplicitRouting ? IMPLICIT_ROUTING_PROPERTIES[key] : undefined)
    if (!propSchema) {
      out[key] = rawVal
      continue
    }
    const fullKey = prefix ? `${prefix}.${key}` : key
    out[key] = coerceAndValidateValue(rawVal, propSchema, fullKey)
  }

  return out
}

/**
 * Validates and normalizes MCP / HTTP / CLI tool arguments against a ToolDefinition's JSON Schema:
 * - Strips `undefined` keys
 * - Safely coerces unambiguous stringified primitives (e.g. `"tabId": "42"` -> `42`, `"force": "true"` -> `true`)
 * - Rejects missing `required` fields, invalid `enum` values, and uncoercible types (e.g. `"tabId": "abc"`)
 *   instead of silently falling back to `undefined` and acting on the wrong browser tab.
 */
export function validateAndNormalizeToolArgs(
  tool: ToolDefinition,
  rawArgs: unknown,
): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) {
    return validateObjectAgainstSchema({}, tool.inputSchema as { properties?: Record<string, JsonSchemaProperty>; required?: string[] }, '', true)
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new Error('Tool arguments must be a JSON object')
  }
  return validateObjectAgainstSchema(
    rawArgs as Record<string, unknown>,
    tool.inputSchema as { properties?: Record<string, JsonSchemaProperty>; required?: string[] },
    '',
    true,
  )
}
