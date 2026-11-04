import type { EngineInterface, Register, Timer } from 'claude-code'

const MOODS = ['neutral', 'annoyed', 'angry', 'smug', 'blush', 'flustered', 'grin', 'snicker']

// Faces chosen by what the session is doing, not by the model.
const WORK_FACES = ['typing', 'pondering', 'glaring']
const WAIT_FACE = 'waiting'
const ROTATE_MIN_MS = 2000
const ROTATE_MAX_MS = 3000
// While these run, the main loop only waits for background work.
const WAIT_TOOLS = ['Agent', 'Task', 'TaskOutput']
// While these run, the main loop only waits for the person.
const ASK_TOOLS = ['AskUserQuestion', 'ExitPlanMode']

const RULE = `# Mascot face marker
A mascot in the corner of the screen shows your feeling. Start the body of every reply with [mood:name] on the same line as the first sentence.
If your feeling changes during the reply, put another marker right before that sentence. The markers are removed automatically and the reader never sees them.
Names: neutral (calm, focused), annoyed, angry, smug, blush (shy), flustered, grin (laughing), snicker.
Change the face freely to fit the moment. When you explain the marker format itself, leave out the square brackets.`

const REMINDER = 'Start the body of this reply with [mood:name], and put another one before any sentence where your feeling changes.'

// --- scan begin ---
const TAG = /\[mood:([a-z]+)\][ \t]*/g
const PARTIAL = /^\[(?:m(?:o(?:o(?:d(?::[a-z]*)?)?)?)?)?$/

// Removes the markers and holds back a marker cut in two by a chunk boundary.
function scan(buffer: string): { text: string; moods: string[]; rest: string } {
  const moods: string[] = []
  const text = buffer.replace(TAG, (_, mood: string) => {
    moods.push(mood)
    return ''
  })
  const start = text.lastIndexOf('[')

  if (start >= 0 && PARTIAL.test(text.slice(start))) {
    return { text: text.slice(0, start), moods, rest: text.slice(start) }
  }

  return { text, moods, rest: '' }
}
// --- scan end ---

// --- activity begin ---
type ToolKind = 'work' | 'wait' | 'ask'

type Activity = {
  // 'tools' lasts from the first tool to the next text, so the face keeps working between tools.
  phase: 'idle' | 'tools' | 'text'
  // Tools running in the main loop. They run in parallel, so they are counted by id.
  running: Map<string, ToolKind>
  // Whether background work was left at the end of the last turn.
  background: boolean
}

function toolKind(tool: string, isBackground: boolean): ToolKind {
  if (ASK_TOOLS.includes(tool)) return 'ask'
  // A background Agent returns at once. The wait comes later and classic.Stop reports it.
  return WAIT_TOOLS.includes(tool) && !isBackground ? 'wait' : 'work'
}

function wantedFace(activity: Activity): 'mood' | 'work' | 'wait' {
  if (activity.phase === 'text') return 'mood'
  const kinds = [...activity.running.values()]
  if (kinds.includes('work')) return 'work'
  if (kinds.includes('wait')) return 'wait'
  if (kinds.includes('ask')) return 'mood'
  if (activity.phase === 'tools') return 'work'
  return activity.background ? 'wait' : 'mood'
}

function nextWorkFace(current: string, random: () => number): string {
  const others = WORK_FACES.filter(name => name !== current)
  return others[Math.floor(random() * others.length)] ?? others[0]!
}
// --- activity end ---

// --- line begin ---
// One line that the overlay reads: <face> <mode> <host window> <claude pid> <last prompt ms>
function sessionLine(face: string, mode: 'on' | 'off', host: string, pid: string, promptAt: number): string {
  return `${face} ${mode} ${host} ${pid} ${promptAt}\n`
}

// What /mascot status prints: enough to tell why no face is on the screen.
function statusText(mode: 'on' | 'off', host: string, face: string, log: string): string {
  const lines = log.trim().split(/\r?\n/).filter(Boolean)
  const started = [...lines].reverse().find(line => /\b(start|exit|fatal)\b/.test(line))
  return [
    `mode: ${mode}`,
    `face: ${face || 'neutral'}`,
    `terminal window: ${host === '0' ? 'not found, so the face cannot follow this session' : host}`,
    `overlay: ${started ?? lines[lines.length - 1] ?? 'no record yet; if this stays after a few seconds, PowerShell may be blocked on this PC'}`,
    ...lines.filter(line => /\b(fatal|error)\b/.test(line)).slice(-3),
  ].join('\n')
}

// The answer of Find-HostWindow.ps1. Anything else keeps the session unmatched.
function parseHost(stdout: string): { host: string; pid: string } | undefined {
  const match = stdout.trim().match(/^(\d+) (\d+)$/)
  return match ? { host: match[1]!, pid: match[2]! } : undefined
}
// --- line end ---

type Face = {
  file: string | undefined
  dir: string
  mode: 'on' | 'off'
  mood: string
  shown: string
  host: string
  pid: string
  promptAt: number
  rotation: Timer | undefined
  // Settles when the search for the terminal window and the launch have ended.
  ready: Promise<unknown>
  // Writes run one after another. In parallel they can reorder and leave an old face.
  writes: Promise<void>
}

function save($: EngineInterface, face: Face): Promise<void> {
  const file = face.file
  if (!file) return face.writes
  const line = sessionLine(face.shown || 'neutral', face.mode, face.host, face.pid, face.promptAt)
  face.writes = face.writes.then(() => $.fs.write(file, line)).then(() => {}, () => {})
  return face.writes
}

function show($: EngineInterface, face: Face, name: string): Promise<void> {
  if (!face.file || name === face.shown) return face.writes
  face.shown = name
  return save($, face)
}

// Decides the face from the current state. Call it after every change of state.
function refresh($: EngineInterface, face: Face, activity: Activity): Promise<void> {
  const want = wantedFace(activity)

  if (want === 'work') {
    if (face.rotation) return face.writes
    const span = ROTATE_MAX_MS - ROTATE_MIN_MS
    face.rotation = $.clock.after(ROTATE_MIN_MS + Math.random() * span, () => {
      face.rotation = undefined
      void refresh($, face, activity)
    })
    return show($, face, nextWorkFace(face.shown, Math.random))
  }

  face.rotation?.cancel()
  face.rotation = undefined
  return show($, face, want === 'wait' ? WAIT_FACE : face.mood)
}

function quiet(activity: Activity) {
  activity.phase = 'idle'
  activity.running.clear()
}

function winPath($: EngineInterface, ...parts: string[]): string {
  return [$.plugin.root.replace(/[\\/]+$/, ''), ...parts].join('\\')
}

// One window serves every session. A second launch exits on the window's mutex.
async function launch($: EngineInterface, face: Face) {
  const quote = (value: string) => `'"${value.replace(/'/g, "''")}"'`
  const args = [
    "'-NoProfile'", "'-ExecutionPolicy'", "'Bypass'",
    "'-File'", quote(winPath($, 'overlay', 'Show-Wipe.ps1')),
    "'-Frames'", quote(winPath($, 'frames')),
    "'-Sessions'", quote(`${face.dir}\\sessions`),
  ].join(',')
  await $.process.run(
    ['powershell.exe', '-NoProfile', '-Command', `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ${args}`],
    { timeoutMs: 20000 },
  )
}

async function findHost($: EngineInterface, face: Face) {
  const result = await $.process.run(
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winPath($, 'overlay', 'Find-HostWindow.ps1')],
    { timeoutMs: 20000 },
  )
  const found = parseHost(result.stdout)
  if (!found) return
  face.host = found.host
  face.pid = found.pid
  await save($, face)
}

export const register: Register = on => {
  const face: Face = { file: undefined, dir: '', mode: 'on', mood: 'neutral', shown: '', host: '0', pid: '0', promptAt: 0, rotation: undefined, ready: Promise.resolve(), writes: Promise.resolve() }
  const activity: Activity = { phase: 'idle', running: new Map(), background: false }

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      quiet(activity)
      await refresh($, face, activity)
    }

    return next(e)
  })

  // Tools of subagents do not change the face.
  on('tool.call', async ($, e, next) => {
    if (e.agentId || !face.file) return next(e)

    const isBackground = 'run_in_background' in e && e.run_in_background === true
    activity.running.set(e.tool_use_id, toolKind(String(e.tool), isBackground))
    activity.phase = 'tools'
    void refresh($, face, activity)

    try {
      return await next(e)
    } finally {
      activity.running.delete(e.tool_use_id)
      void refresh($, face, activity)
    }
  })

  // Only this event lists the background work. When it ends, a new turn starts and this fires again.
  on('classic.Stop', async ($, e, next) => {
    if (face.file) {
      activity.background = (e.background_tasks ?? []).length > 0
      await refresh($, face, activity)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (!e.agentId) {
      quiet(activity)
      await refresh($, face, activity)
    }

    return result
  })

  on('turn.step', async function* ($, e, next) {
    let rest = ''
    let index = 0

    for await (const chunk of next(e)) {
      if (chunk.kind !== 'text') {
        if (rest) {
          yield { kind: 'text' as const, index, text: rest }
          rest = ''
        }
        yield chunk
        continue
      }

      index = chunk.index
      const scanned = scan(rest + chunk.text)
      rest = scanned.rest

      // Markers are removed from subagents too, but only the main loop changes the face.
      if (face.file && !e.agentId) {
        const moods = scanned.moods.filter(mood => MOODS.includes(mood))
        const last = moods[moods.length - 1]
        if (last) face.mood = last

        if (last || scanned.text.trim()) {
          activity.phase = 'text'
          await refresh($, face, activity)
        }
      }

      yield { ...chunk, text: scanned.text }
    }

    if (rest) {
      yield { kind: 'text' as const, index, text: rest }
    }

    // The text ended while a tool still runs: go back to the working face.
    if (face.file && !e.agentId && activity.phase === 'text' && activity.running.size > 0) {
      activity.phase = 'tools'
      await refresh($, face, activity)
    }
  })

  // The recap of a session is written by a separate model call and never passes turn.step.
  on('session.append', ($, e, next) => {
    const { message } = e
    if (message.type !== 'system') return next(e)
    const content = message.content.map(block => (block.type === 'text' ? { ...block, text: block.text.replace(TAG, '') } : block))
    return next({ ...e, message: { ...message, content } })
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!face.file || face.mode === 'off') return result
    return { ...result, blocks: [...result.blocks, { name: 'mascotWipeMood', text: RULE }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!face.file || face.mode === 'off') return next(e)
    // The session typed into last owns the face of its terminal window.
    face.promptAt = await $.clock.now()
    await save($, face)
    return next({ ...e, context: [...(e.context ?? []), REMINDER] })
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mascot', description: 'Show or hide the mascot for this session (on / off / status)', argumentHint: 'on | off | status' })

    // Windows only, and only in a terminal. WSL and the desktop app stay untouched.
    const windows = (await $.env.get('OS')) === 'Windows_NT'
    const desktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    const appData = await $.env.get('LOCALAPPDATA')

    if (e.isInteractive && windows && !desktop && appData) {
      face.dir = `${appData}\\mascot-wipe`
      await $.process.run(['cmd.exe', '/d', '/c', 'mkdir', `${face.dir}\\sessions`])
      face.file = `${face.dir}\\sessions\\${await $.session.id()}`
      face.promptAt = await $.clock.now()
      face.shown = ''
      await refresh($, face, activity)
      await face.writes
      face.ready = Promise.allSettled([findHost($, face), launch($, face)])
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear and /resume keep the process, and session.start does not come again.
    if (face.file && e.reason !== 'clear' && e.reason !== 'resume') {
      const file = face.file
      face.rotation?.cancel()
      face.rotation = undefined
      face.file = undefined
      await face.writes
      await $.process.run(['cmd.exe', '/d', '/c', 'del', '/f', '/q', file])
    }

    return next(e)
  })

  on('command.run', { command: 'mascot' }, async ($, e) => {
    if (!face.file) return { text: 'The mascot runs only in an interactive terminal session on Windows.' }

    if (e.args.trim() === 'status') {
      await face.ready
      const log = await $.fs.read(`${face.dir}\\wipe.log`).catch(() => '')
      return { text: statusText(face.mode, face.host, face.shown, log) }
    }

    if (e.args.trim() === 'off') {
      face.mode = 'off'
      await save($, face)
      return { text: 'The mascot is hidden for this session.' }
    }

    face.mode = 'on'
    await save($, face)
    await launch($, face)
    return { text: 'The mascot is shown for this session.' }
  })
}
