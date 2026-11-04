import { expect, mock, test } from 'claude-code/testing'
import type { TurnStepChunk } from 'claude-code'

const WORK = ['typing', 'pondering', 'glaring']
const PANE = 'abcdef12-3456'

// ツールを手で終わらせられるようにした、エンジンの代わり
function world(on: Parameters<Parameters<typeof test>[1]>[1], env: Record<string, string> = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\L' }, pane = PANE) {
  const clock = mock.clock(on)
  mock.env(on, env)
  const written: string[] = []
  const lines: string[] = []
  const finish = new Map<string, () => void>()
  const chunks: { list: TurnStepChunk[] } = { list: [] }

  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_, e) => {
    // テストは Linux で動くので、C:\ のパスは作業フォルダからの相対に解かれる
    lines.push(String(e.text))
    if (String(e.path).endsWith(pane)) written.push(String(e.text).split(' ')[0]!)
    return { value: undefined }
  })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: JSON.stringify(e).includes('Find-HostWindow') ? '555 777\r\n' : '', stderr: '' } }))
  on('fs.read', () => ({ value: '' }))
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'abcdef12-3456' }))
  on('session.surfaces', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'wipe' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: false } }))
  on('turn.step', async function* (_, e) {
    for (const chunk of chunks.list) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.call', (_, e) => new Promise(resolve => {
    finish.set(String(e.tool_use_id), () => resolve({ result: {} }))
  }))

  return { clock, written, lines, finish, chunks, last: () => written[written.length - 1] }
}

// 書き込みの列を流す。mock.clock の settle は実際の非同期の進行を待たないので、実時間で待つ
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30))

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 窓の番号の書き込みは裏で走るので、それが済んでから顔を見る
  await settle()
  await $.turn.start({ text: 'x', turnId: 't1' })
}

function runTool($: any, id: string, tool: string, input: object = {}) {
  return $.tool.call({ tool, tool_use_id: id, ...input })
}

async function stream($: any, w: ReturnType<typeof world>, text: string) {
  w.chunks.list = [{ kind: 'text', index: 0, text }] as TurnStepChunk[]
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) void chunk
}

test('ツールが走る間は作業顔で、同じ顔を続けない', async ($, on) => {
  const w = world(on)
  await start($)
  const run = runTool($, 'a', 'Bash', { command: 'sleep 9' })
  await settle()

  for (let i = 0; i < 12; i++) {
    await w.clock.advance(3001)
    await settle()
  }

  // 最初の 2 行は起動時の顔と、窓の番号を足した書き直し
  const faces = w.written.slice(2)
  expect(faces.length).toBeGreaterThan(5)
  for (const face of faces) expect(WORK).toContain(face)
  for (let i = 1; i < faces.length; i++) expect(faces[i]).not.toBe(faces[i - 1])

  w.finish.get('a')!()
  await run
})

test('手前の Agent を待つ間は待ち顔で、回らない', async ($, on) => {
  const w = world(on)
  await start($)
  const run = runTool($, 'a', 'Agent', { prompt: 'x', description: 'x' })
  await settle()
  await w.clock.advance(10000)
  await settle()

  expect(w.written.slice(2)).toEqual(['waiting'])

  w.finish.get('a')!()
  await run
})

test('ターンの終わりに裏の処理が残っていれば待ち顔、無くなれば感情に戻る', async ($, on) => {
  const w = world(on)
  on('classic.Stop', () => ({}))
  await start($)
  await stream($, w, '[mood:smug]書いた')
  expect(w.last()).toBe('smug')

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b', type: 'shell', status: 'running', description: 'x' }] } as any)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  expect(w.last()).toBe('waiting')

  await $.turn.start({ text: '', turnId: 't2' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
  await settle()
  expect(w.last()).toBe('smug')
})

test('文を書き始めたら感情の顔に戻り、回転は止まる', async ($, on) => {
  const w = world(on)
  await start($)
  const run = runTool($, 'a', 'Read', { file_path: '/x' })
  await settle()
  w.finish.get('a')!()
  await run
  await settle()
  expect(WORK).toContain(w.last())

  await stream($, w, '[mood:grin]できた')
  expect(w.last()).toBe('grin')

  const count = w.written.length
  await w.clock.advance(20000)
  await settle()
  expect(w.written.length).toBe(count)
})

test('並行のツールは最後の 1 本が終わるまで作業顔のまま', async ($, on) => {
  const w = world(on)
  await start($)
  const a = runTool($, 'a', 'Bash', { command: 'x' })
  const b = runTool($, 'b', 'Agent', { prompt: 'x', description: 'x' })
  await settle()
  expect(WORK).toContain(w.last())

  // 片方が終わっても乱れない。作業のツールが終わると待ち顔へ移る
  w.finish.get('a')!()
  await a
  await settle()
  expect(w.last()).toBe('waiting')

  w.finish.get('b')!()
  await b
  await settle()
  expect(WORK).toContain(w.last())

  // 1 回の開始で回転は 1 本だけ
  const before = w.written.length
  await w.clock.advance(3001)
  await settle()
  expect(w.written.length).toBe(before + 1)
})

test('サブエージェントのツールと文では顔を変えない', async ($, on) => {
  const w = world(on)
  await start($)
  const before = w.written.length
  expect(before).toBeGreaterThan(0)
  const run = runTool($, 'a', 'Bash', { command: 'x', agentId: 'sub' })
  await settle()
  expect(w.written.length).toBe(before)
  w.finish.get('a')!()
  await run
})

test('人の返事を待つツールの間は回らない', async ($, on) => {
  const w = world(on)
  await start($)
  const run = runTool($, 'a', 'AskUserQuestion', { questions: [] })
  await settle()
  await w.clock.advance(10000)
  await settle()
  expect(w.written.length).toBeGreaterThan(0)
  for (const face of w.written) expect(WORK).not.toContain(face)
  w.finish.get('a')!()
  await run
})

test('-p の実行は窓に触らず、決まりも足さない', async ($, on) => {
  const w = world(on, {})
  on('prompt.context', () => ({ blocks: [] }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await settle()
  expect(w.written).toEqual([])
  const context = await $.prompt.context({ blocks: [] } as any)
  expect(context.blocks).toEqual([])
})

test('印の感情が顔になり、本文から消える', async ($, on) => {
  const w = world(on)
  await start($)
  await stream($, w, '[mood:angry]hello')
  expect(w.last()).toBe('angry')
})

test('窓の番号とプロセスを登録に書く', async ($, on) => {
  const w = world(on)
  await start($)
  await settle()
  expect(w.lines.some(line => / on 555 777 \d+/.test(line))).toBe(true)
})

for (const [name, env] of [
  ['WSL', { LOCALAPPDATA: 'C:\\L' }],
  ['デスクトップアプリ', { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\L', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }],
] as const) {
  test(`${name} では窓に触らない`, async ($, on) => {
    const w = world(on, env)
    await start($)
    await settle()
    expect(w.written).toEqual([])
  })
}

test('recap の行からも印を消す', async ($, on) => {
  world(on)
  let stored = ''
  on('session.append', (_, e, next) => {
    stored = JSON.stringify(e.message.content)
    return next(e)
  })
  await $.session.append({ message: { type: 'system', subtype: 'away_summary', content: [{ type: 'text', text: '[mood:neutral]done' }] } } as any)
  expect(stored).toBe(JSON.stringify([{ type: 'text', text: 'done' }]))
})

test('/mascot status は窓と小窓の状態を返す', async ($, on) => {
  const w = world(on)
  await start($)
  await settle()
  expect(w).toBeDefined()
  const r = await $.command.run({ command: 'mascot', args: 'status' } as any)
  expect((r as any).text).toContain('terminal window: 555')
  expect((r as any).text).toContain('no record yet')
})
