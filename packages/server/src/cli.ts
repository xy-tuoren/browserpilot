#!/usr/bin/env node
import { BROWSERPILOT_VERSION } from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import { parseFlags, printHelp } from './cli/args.js'
import { runDirectToolShortcutCommand } from './cli/commands.js'
import {
  runBrowserStartCommand,
  runCodegenCommand,
  runDaemonCommand,
  runExecCommand,
  runSessionCommand,
  runTraceCommand,
} from './cli/daemon-browser.js'
import { runDoctorCommand, runSetupCommand } from './cli/setup-doctor.js'
import { startMcpServer } from './mcp.js'
import { BROWSERPILOT_SKILL_DOC } from './skill-doc.js'

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2))
  const cmd = positional[0]

  if (cmd === 'version' || flags.version || flags.v) {
    console.log(BROWSERPILOT_VERSION)
    return
  }

  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    printHelp()
    return
  }

  if (cmd === 'skill') {
    console.log(BROWSERPILOT_SKILL_DOC)
    return
  }

  if (cmd === 'doctor') {
    await runDoctorCommand(flags)
    return
  }

  if (cmd === 'mcp') {
    await startMcpServer({
      cdpEndpoint: typeof flags.cdp === 'string' ? flags.cdp : undefined,
      daemonHost: typeof flags.host === 'string' ? flags.host : undefined,
      daemonPort: typeof flags.port === 'string' ? Number(flags.port) : undefined,
      daemonToken: typeof flags.token === 'string' ? flags.token : undefined,
      full: Boolean(flags.full),
      capabilities: typeof flags.caps === 'string' ? flags.caps : undefined,
    })
    return
  }

  if (cmd === 'setup') {
    await runSetupCommand(flags)
    return
  }

  if (cmd === 'daemon') {
    await runDaemonCommand(positional[1] || 'status', flags)
    return
  }

  if (cmd === 'browser' && positional[1] === 'start') {
    await runBrowserStartCommand(flags)
    return
  }

  const client = await DaemonClient.connectOrStart()
  const clientId = typeof flags.client === 'string' ? flags.client : undefined
  const tabId = typeof flags.tab === 'string' ? Number(flags.tab) : undefined
  const sessionId =
    typeof flags.s === 'string' ? flags.s : typeof flags.session === 'string' ? flags.session : undefined

  if (cmd === 'connect-cdp') {
    const endpoint = positional[1] || 'http://127.0.0.1:9222'
    const info = await client.connectDirectCDP(endpoint)
    console.log(JSON.stringify(info, null, 2))
    return
  }

  if (cmd === 'session') {
    await runSessionCommand(client, positional, flags)
    return
  }

  if (cmd === 'exec') {
    await runExecCommand(client, flags, { sessionId, tabId })
    return
  }

  if (cmd === 'codegen') {
    await runCodegenCommand(client, positional, flags, { tabId, sessionId, clientId })
    return
  }

  if (cmd === 'trace') {
    await runTraceCommand(client, positional, flags, { tabId, sessionId, clientId })
    return
  }

  await runDirectToolShortcutCommand(client, cmd, positional, flags, { tabId, sessionId, clientId })
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
