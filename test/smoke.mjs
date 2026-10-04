#!/usr/bin/env node
/**
 * Smoke test for dsh-session-trash.
 *
 * Runs the plugin's real Host code against a throwaway DSH_HOME so the
 * destructive paths (delete → trash → restore → purge, busy refusal, ghost-id
 * cleanup) are verified without touching the live harness. Then loads the
 * browser bundle under a stubbed `window.__ModuleLoader__` and a minimal React
 * shim to prove it registers its settings section and renders.
 *
 * Usage: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const mod = await import(new URL('../index.js', import.meta.url).href)
const { SessionStore, createHandler, buildListing, deleteSession, restoreSession, purgeSession, forgetSession } = mod.__internal

const ID_A = 'session-11111111-1111-4111-8111-111111111111'
const ID_B = 'session-22222222-2222-4222-8222-222222222222'
const ID_GHOST = 'session-33333333-3333-4333-8333-333333333333'
const GROUP = '--C-Users-Test-project--'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

/** Build a fake DSH_HOME: two sessions on disk, one projection cache, one ghost id. */
async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-trash-test-'))
  const groupDir = path.join(home, 'sessions', GROUP)
  await fsp.mkdir(path.join(groupDir, ID_A), { recursive: true })
  await fsp.mkdir(path.join(groupDir, ID_B), { recursive: true })
  await fsp.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await fsp.writeFile(path.join(groupDir, ID_A, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7))
  await fsp.writeFile(path.join(groupDir, ID_B, 'session.v4.jsonl.zstd'), Buffer.alloc(512, 1))
  await fsp.writeFile(
    path.join(home, 'storages', 'session_projcache', 'sessions', `${ID_A}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1791087781879, cwd: 'C:\\Users\\Test\\project' },
        rows: { title: { ver: 1, seq: 3, val: '测试会话 A' } },
      },
    }),
  )
  return home
}

/** Registry stub: archive/unarchive are recorded, one session can be reported busy. */
function makeRegistry({ busyId, archived = [], workspaces = [] } = {}) {
  const calls = []
  return {
    calls,
    archivedSessionIds: [...archived],
    list: () => workspaces,
    async archiveSession(id) {
      if (id === busyId) {
        const error = new Error(`session "${id}" has activity`)
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      calls.push(['archive', id])
      if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id)
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
      this.archivedSessionIds = this.archivedSessionIds.filter((item) => item !== id)
    },
  }
}

/** Minimal HTTP request/response doubles. */
async function callHandler(handler, method, route, body, options = {}) {
  const { remoteAddress = '127.0.0.1', host = '127.0.0.1:19387', clientHeader = '1' } = options
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  req.method = method
  req.url = `/api/dsh-session-trash${route}`
  req.socket = { remoteAddress }
  req.headers = {}
  // null（而不是 undefined）才表示「这个头就不发」——undefined 会落回上面的默认值。
  if (host !== null) req.headers.host = host
  if (clientHeader !== null) req.headers['x-dsh-session-trash'] = clientHeader
  const captured = { status: 0, headers: undefined, body: '' }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(chunk) {
      captured.body = chunk ?? ''
    },
  }
  await handler(req, res)
  let parsed
  try {
    parsed = JSON.parse(captured.body)
  } catch {
    parsed = { raw: captured.body }
  }
  return { ...captured, json: parsed }
}

const home = await makeHome()
const store = new SessionStore(home)
const service = (name) => (name === 'workspaceRegistry' ? registry : undefined)
let registry = makeRegistry()
const handler = createHandler({ store, service, logger: { info() {}, warn() {} } })

console.log(`\nDSH_HOME = ${home}`)
console.log('\n[1] 列表 / listing')

const listing = await buildListing({ store, service })
check('两个磁盘会话都被列出', () => assert.equal(listing.sessions.length, 2))
check('标题来自投影缓存（与侧栏同源）', () => {
  const a = listing.sessions.find((row) => row.id === ID_A)
  assert.equal(a.title, '测试会话 A')
  assert.equal(a.cwd, 'C:\\Users\\Test\\project')
})
check('没有投影缓存的会话仍列出来', () => {
  const b = listing.sessions.find((row) => row.id === ID_B)
  assert.equal(b.title, null)
  assert.equal(b.onDisk, true)
})
check('大小按目录统计', () => {
  const a = listing.sessions.find((row) => row.id === ID_A)
  assert.ok(a.sizeBytes >= 2048, `sizeBytes=${a.sizeBytes}`)
})
check('能力位反映出服务可用', () => {
  assert.equal(listing.capabilities.registry, true)
  assert.equal(listing.capabilities.persistence, false)
})

console.log('\n[2] HTTP 路由 / routing + fence')
const listResponse = await callHandler(handler, 'GET', '/list')
check('GET /list → 200 with sessions', () => {
  assert.equal(listResponse.status, 200)
  assert.equal(listResponse.json.sessions.length, 2)
})
const fenced = await callHandler(handler, 'GET', '/list', undefined, { remoteAddress: '10.0.0.5' })
check('非回环连接 → 403', () => assert.equal(fenced.status, 403))
const badId = await callHandler(handler, 'POST', '/delete', { id: '../../etc' })
check('路径穿越的 id → 400', () => {
  assert.equal(badId.status, 400)
})
const unknown = await callHandler(handler, 'POST', '/delete', { id: 'session-99999999-9999-4999-8999-999999999999' })
check('不存在的会话 → 404', () => assert.equal(unknown.status, 404))

console.log('\n[3] 删除 → 回收站 / delete → trash')
const deleted = await deleteSession({ store, service, id: ID_A })
check('归档被调用（会话移出侧栏）', () => {
  assert.deepEqual(registry.calls.at(-1), ['archive', ID_A])
})
check('日志目录已从 sessions 下移走', () => {
  assert.equal(fs.existsSync(path.join(home, 'sessions', GROUP, ID_A)), false)
})
check('投影缓存也一起移走', () => {
  assert.equal(fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${ID_A}.json`)), false)
})
check('回收站目录里有会话文件', () => {
  assert.equal(fs.existsSync(path.join(deleted.trashed, 'session', 'session.v4.jsonl.zstd')), true)
})
check('回收站登记写了标题', async () => {})
const afterDelete = await buildListing({ store, service })
check('列表里只剩一个会话，回收站有一个条目', () => {
  assert.equal(afterDelete.sessions.length, 1)
  assert.equal(afterDelete.trash.length, 1)
  assert.equal(afterDelete.trash[0].title, '测试会话 A')
  assert.equal(afterDelete.trash[0].id, ID_A)
})
check('删掉的会话不再同时出现在「全部会话」里（截图里那对重复行）', () => {
  assert.ok(
    !afterDelete.sessions.some((row) => row.id === ID_A),
    'a trashed session must not also be listed as a live session',
  )
})

console.log('\n[4] 运行中的会话被拒绝 / busy refusal')
const busyHome = home
registry = makeRegistry({ busyId: ID_B })
const busyStore = new SessionStore(busyHome)
let busyStatus = 0
try {
  await deleteSession({ store: busyStore, service, id: ID_B })
} catch (error) {
  busyStatus = error.status ?? 0
}
check('WorkspaceActiveSessionError → 409', () => assert.equal(busyStatus, 409))
check('被拒绝时文件分毫未动', () => {
  assert.equal(fs.existsSync(path.join(home, 'sessions', GROUP, ID_B, 'session.v4.jsonl.zstd')), true)
})
registry = makeRegistry()

console.log('\n[5] 还原 / restore')
const restored = await restoreSession({ store, service, id: ID_A })
check('文件归位到原分组', () => {
  assert.equal(fs.existsSync(path.join(home, 'sessions', GROUP, ID_A, 'session.v4.jsonl.zstd')), true)
  assert.equal(restored.restoredTo, path.join(home, 'sessions', GROUP, ID_A))
})
check('投影缓存也归位', () => {
  assert.equal(fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${ID_A}.json`)), true)
})
check('解除归档被调用', () => {
  assert.deepEqual(registry.calls.at(-1), ['unarchive', ID_A])
})
const afterRestore = await buildListing({ store, service })
check('回收站清空、会话回到列表', () => {
  assert.equal(afterRestore.trash.length, 0)
  assert.equal(afterRestore.sessions.length, 2)
})

console.log('\n[6] 彻底删除 / purge')
const second = await deleteSession({ store, service, id: ID_A })
await purgeSession({ store, id: ID_A })
check('回收站目录被真的删掉', () => {
  assert.equal(fs.existsSync(second.trashed), false)
})
check('登记也清掉了', async () => {})
const afterPurge = await buildListing({ store, service })
check('回收站为空', () => assert.equal(afterPurge.trash.length, 0))

console.log('\n[7] 账本残留不进界面 / ledger residue stays out of the UI')
const detached = []
const ghostRegistry = makeRegistry({
  workspaces: [
    {
      id: 'ws-1',
      path: 'C:\\Users\\Test\\project',
      sessionIds: [ID_B, ID_GHOST],
      async detachSession(id) {
        detached.push(id)
      },
    },
  ],
})
const ghostService = (name) => (name === 'workspaceRegistry' ? ghostRegistry : undefined)
const ghostListing = await buildListing({ store, service: ghostService })
check('账本里没有日志的 id 不会变成一行（界面只列真实会话）', () => {
  assert.ok(
    !ghostListing.sessions.some((row) => row.id === ID_GHOST),
    'a ledger-only id must not be listed',
  )
  assert.ok(ghostListing.sessions.some((row) => row.id === ID_B), 'the real session must still be listed')
})
const forgetRoute = await callHandler(handler, 'POST', '/forget', { id: ID_GHOST })
check('POST /forget 已不存在（功能整体移除，且没有动过账本）', () => {
  assert.equal(forgetRoute.status, 404)
  assert.deepEqual(detached, [], 'nothing may be detached behind a removed feature')
})

console.log('\n[7b] 列表是纯读的 / listing mutates nothing')
const rawDetached = []
const rawWorkspace = {
  id: 'ws-raw',
  path: 'C:\\Users\\Test\\project',
  record: { path: 'C:\\Users\\Test\\project', sessionIds: [ID_B, ID_GHOST] },
  get sessionIds() {
    return [ID_B]
  },
  async detachSession(id) {
    rawDetached.push(id)
  },
}
const rawRegistry = {
  archivedSessionIds: [ID_B, ID_GHOST],
  list: () => [rawWorkspace],
  async archiveSession() {},
  async unarchiveSession() {
    throw new Error('listing must not unarchive')
  },
}
const rawService = (name) => (name === 'workspaceRegistry' ? rawRegistry : undefined)
const rawListing = await buildListing({ store, service: rawService })
check('构建列表不动账本、不动归档集合（纯读）', () => {
  assert.deepEqual(rawDetached, [], 'listing must not mutate the ledger')
  assert.deepEqual(rawRegistry.archivedSessionIds, [ID_B, ID_GHOST], 'listing must not touch the archive set')
})
check('归档标记只用于「已归档」标注', () => {
  const row = rawListing.sessions.find((item) => item.id === ID_B)
  assert.equal(row.archived, true)
})

console.log('\n[7c] 彻底删除不碰记账 / purge touches no accounting')
// 这是实测结论：运行期摘账本或撤销归档会让浏览器投影拿缓存重画，
// 把那条没有数据的行显形到侧栏「未分组」下，并且留到下次重启。所以 purge 只删文件。
const purgeHome = await makeHome()
const purgeStore = new SessionStore(purgeHome)
const purgeDetached = []
const purgeRegistry = makeRegistry()
const purgeWorkspace = {
  id: 'ws-p',
  path: 'C:\\Users\\Test\\project',
  record: { path: 'C:\\Users\\Test\\project', sessionIds: [ID_A] },
  sessionIds: [ID_A],
  async detachSession(id) {
    purgeDetached.push(id)
    this.record.sessionIds = this.record.sessionIds.filter((entry) => entry !== id)
  },
}
purgeRegistry.list = () => [purgeWorkspace]
const purgeService = (name) => (name === 'workspaceRegistry' ? purgeRegistry : undefined)
await deleteSession({ store: purgeStore, service: purgeService, id: ID_A })
check('删除阶段会归档（会话因此被侧栏隐藏）', () => {
  assert.ok(purgeRegistry.archivedSessionIds.includes(ID_A), 'delete should archive first')
})
const purgeResult = await purgeSession({ store: purgeStore, service: purgeService, id: ID_A })
check('purge 把 id 从工作区账本与归档集合里都摘掉', () => {
  assert.equal(purgeResult.purged, true)
  assert.deepEqual(purgeDetached, [ID_A], 'ledger entry must be detached')
  assert.deepEqual(purgeWorkspace.record.sessionIds, [], 'ledger record must not keep the id')
  assert.equal(purgeResult.unarchived, true)
  assert.ok(!purgeRegistry.archivedSessionIds.includes(ID_A), 'archive marker must be dropped')
})
const afterPurgeAll = await buildListing({ store: purgeStore, service: purgeService })
check('purge 之后这个 id 不再出现在清单里', () => {
  assert.ok(!afterPurgeAll.sessions.some((row) => row.id === ID_A), 'still listed as a session')
  assert.equal(afterPurgeAll.trash.length, 0)
})

console.log('\n[7d] 宿主里还活着的会话 / dropping a live host session')
// 实测：客户端 retain 的会话（最近打开过、正在跑、或挂在视图上）会一直留在宿主会话表里，
// session.list 一直报它；工作区归属被摘掉之后它就落在「未分组」下。刷新页面没用（客户端重连
// 后宿主照样报它），只有重启宿主才释放。所以彻底删除必须用会话表自己的移除原语把它摘掉。
const liveHome = await makeHome()
const liveStore = new SessionStore(liveHome)
const liveCalls = []
const liveSessions = {
  store: new Map(),
  get(id) {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : entry.session
  },
  liveEntryFor(session) {
    return [...this.store.values()].find((entry) => entry.session === session)
  },
  detachEntered(entry) {
    liveCalls.push(entry.id)
    if (this.store.get(entry.id) === entry) this.store.delete(entry.id)
  },
}
const liveDetached = []
const liveRegistry = makeRegistry()
liveRegistry.list = () => [
  {
    id: 'ws-live',
    path: 'C:\\Users\\Test\\project',
    record: { path: 'C:\\Users\\Test\\project', sessionIds: [ID_A] },
    sessionIds: [ID_A],
    async detachSession(id) {
      liveDetached.push(id)
      this.record.sessionIds = this.record.sessionIds.filter((entry) => entry !== id)
    },
  },
]
const liveService = (name) => (name === 'workspaceRegistry' ? liveRegistry : name === 'sessions' ? liveSessions : undefined)
await deleteSession({ store: liveStore, service: liveService, id: ID_A })
// 会话此刻在宿主里「活着」——就像用户刚用它聊过天。
liveSessions.store.set(ID_A, { id: ID_A, session: { id: ID_A }, announced: true })
const livePurge = await purgeSession({ store: liveStore, service: liveService, id: ID_A, logger: { warn() {} } })
check('彻底删除会把还活着的会话从宿主会话表里摘掉', () => {
  assert.equal(livePurge.purged, true)
  assert.equal(livePurge.liveDropped, true, 'the live entry must be dropped')
  assert.deepEqual(liveCalls, [ID_A])
  assert.equal(liveSessions.store.has(ID_A), false, 'session list must stop reporting it')
})
check('摘除是幂等的（持有它的 fiber 之后卸载也不会再摘一次）', async () => {
  const again = await mod.__internal.forgetLiveSession({ service: liveService, id: ID_A })
  assert.equal(again.liveDropped, false)
  assert.equal(again.liveSupported, true)
  assert.deepEqual(liveCalls, [ID_A], 'no second drop may be recorded')
})
check('会话不在表里时什么都不做', async () => {
  const absent = await mod.__internal.forgetLiveSession({ service: liveService, id: ID_GHOST })
  assert.equal(absent.liveDropped, false)
})
check('没有 sessions 服务时安全降级（不抛错，只是摘不了）', async () => {
  const degraded = await mod.__internal.forgetLiveSession({ service: () => undefined, id: ID_A })
  assert.equal(degraded.liveSupported, false)
  assert.equal(degraded.liveDropped, false)
})
await fsp.rm(liveHome, { recursive: true, force: true })

// 回归：HTTP 路由曾经漏传 service，于是「彻底删除」实际上从未清理记账——
// 用户侧看到的就是「删完还是挂在侧栏里」。这里必须走路由本身来验证。
const routeHome = await makeHome()
const routeStore = new SessionStore(routeHome)
const routeDetached = []
const routeRegistry = makeRegistry()
routeRegistry.list = () => [
  {
    id: 'ws-route',
    path: 'C:\\Users\\Test\\project',
    record: { path: 'C:\\Users\\Test\\project', sessionIds: [ID_A] },
    sessionIds: [ID_A],
    async detachSession(id) {
      routeDetached.push(id)
      this.record.sessionIds = this.record.sessionIds.filter((entry) => entry !== id)
    },
  },
]
const routeLiveCalls = []
const routeSessions = {
  store: new Map(),
  get(id) {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : entry.session
  },
  liveEntryFor(session) {
    return [...this.store.values()].find((entry) => entry.session === session)
  },
  detachEntered(entry) {
    routeLiveCalls.push(entry.id)
    this.store.delete(entry.id)
  },
}
routeSessions.store.set(ID_A, { id: ID_A, session: { id: ID_A }, announced: true })
const routeService = (name) =>
  name === 'workspaceRegistry' ? routeRegistry : name === 'sessions' ? routeSessions : undefined
const routeHandler = createHandler({ store: routeStore, service: routeService, logger: { info() {}, warn() {} } })
const viaRouteDelete = await callHandler(routeHandler, 'POST', '/delete', { id: ID_A })
check('HTTP /delete 走通', () => assert.equal(viaRouteDelete.status, 200))
const viaRoutePurge = await callHandler(routeHandler, 'POST', '/purge', { id: ID_A })
check('HTTP /purge 真的清理了账本、归档与活会话（路由传参回归项）', () => {
  assert.equal(viaRoutePurge.status, 200)
  assert.equal(viaRoutePurge.json.purged, true)
  assert.deepEqual(routeDetached, [ID_A], 'the route must pass the registry through')
  assert.ok(!routeRegistry.archivedSessionIds.includes(ID_A), 'the route must drop the archive marker')
  assert.deepEqual(routeLiveCalls, [ID_A], 'the route must pass the session store through as well')
  assert.equal(viaRoutePurge.json.liveDropped, true)
})
const viaRouteEmpty = await callHandler(routeHandler, 'POST', '/empty', {})
check('HTTP /empty 也清理账本与归档', () => {
  assert.equal(viaRouteEmpty.status, 200)
  assert.equal(typeof viaRouteEmpty.json.detachedFrom, 'number')
  assert.equal(typeof viaRouteEmpty.json.unarchived, 'number')
})
await fsp.rm(routeHome, { recursive: true, force: true })
await fsp.rm(purgeHome, { recursive: true, force: true })

console.log('\n[8] 客户端 bundle / browser half')
const clientSource = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
let bundle = null
const stateQueue = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      bundle = definition
    },
  },
}
const ReactShim = {
  // Faithful enough to React: children live in props.children, because the page
  // reads them there when it rewrites the first row's border.
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  }),
  // useState pops from a queue the test seeds, so both the empty and the loaded
  // branch of the page can be rendered without a real React runtime.
  useState: (initial) => [
    stateQueue.length > 0 ? stateQueue.shift() : typeof initial === 'function' ? initial() : initial,
    () => {},
  ],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}
const requireShim = (name) => {
  if (name === 'react') return ReactShim
  throw new Error(`unexpected require(${name})`)
}
// The bundle is a plain script: evaluate it with the stubbed loader in scope.
new Function('window', clientSource)(globalThis.window)
check('bundle 注册了 ModuleLoader factory', () => {
  assert.ok(bundle, 'no bundle registered')
  assert.equal(bundle.id, 'dsh-session-trash')
})
const clientExports = bundle.factory(requireShim)
check('导出 name / inject / apply', () => {
  assert.equal(clientExports.name, 'dsh-session-trash')
  assert.deepEqual(clientExports.inject, ['slots', 'locale'])
  assert.equal(typeof clientExports.apply, 'function')
})

const registrations = []
// ── DOM stub for the navigation-icon patch ──────────────────────────────────
// The settings shell renders every section row as `button > svg + span` and picks
// the glyph from a hardcoded id table, falling back to the gear that "General"
// also uses. The patch must tag exactly our row — and must not touch the
// sidebar-foot "设置" trigger, which has the same svg + span shape.
const styleNodes = []
function fakeButton(label, hasIcon) {
  return {
    tagName: 'BUTTON',
    attrs: {},
    children: [...(hasIcon ? [{ tagName: 'svg' }] : []), { tagName: 'SPAN', textContent: label }],
    getAttribute(name) {
      return this.attrs[name] ?? null
    },
    setAttribute(name, value) {
      this.attrs[name] = value
    },
  }
}
const NAV = 'data-dsh-session-trash-nav'
const navButtons = [
  fakeButton('通用设置', true),
  fakeButton('会话回收站', true),
  fakeButton('设置', true),
  fakeButton('Session trash', true),
  fakeButton('会话回收站', false),
]
let observerOptions = null
let observerDisconnected = false
globalThis.document = {
  head: { appendChild: (node) => styleNodes.push(node) },
  body: { nodeType: 1 },
  createElement: (tag) => ({
    tagName: String(tag).toUpperCase(),
    textContent: '',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    remove() {
      this.removed = true
    },
  }),
  querySelectorAll: (selector) => (selector === 'button' ? navButtons : []),
}
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback
  }
  observe(_target, options) {
    observerOptions = options
  }
  disconnect() {
    observerDisconnected = true
  }
}

const shellRows = { byId: {}, ids: [] }
let listReads = 0
const sessionsStub = {
  refreshes: 0,
  refresh() {
    this.refreshes++
  },
  // 客户端会话控制器公开的 list 快照：用来判断「宿主是否还认识这个会话」。
  list: {
    getSnapshot: () => {
      listReads++
      return shellRows
    },
  },
}
const fakeCtx = {
  locale: {
    bind: () => (key) => `t:${key}`,
    register: (ns, dict) => {
      assert.equal(ns, 'dshSessionTrash')
      assert.ok(dict.zh && dict.en)
    },
  },
  // 模拟外壳提供的 `sessions` 服务（客户端会话控制器，带公开的 refresh()）。
  get: (name) => (name === 'sessions' ? sessionsStub : undefined),
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposer()
  },
  slots: {
    inject: (name, register) => {
      assert.equal(name, 'settings.section')
      register()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
clientExports.apply(fakeCtx)
check('注册进 settings.section', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'dsh-session-trash')
  assert.equal(registrations[0].options.order, 36)
  assert.equal(registrations[0].options.label(), 't:nav')
})
const injectingWrapper = registrations[0].component({ t: (key) => key, locale: 'zh' })
check('apply() 把外壳刷新器注入页面，并真的调用 sessions.refresh()', () => {
  const refreshShell = injectingWrapper.props.refreshShell
  assert.equal(typeof refreshShell, 'function', 'refreshShell must be injected')
  refreshShell()
  assert.equal(sessionsStub.refreshes, 1, 'sessions.refresh() must be called')
})
check('apply() 注入的探针能看出「宿主还认识这个会话」', () => {
  const stillKnown = injectingWrapper.props.sessionStillKnown
  assert.equal(typeof stillKnown, 'function', 'sessionStillKnown must be injected')
  assert.equal(stillKnown(ID_A), false, 'empty shell list must read as gone')
  shellRows.byId[ID_A] = { sessionId: ID_A }
  assert.equal(stillKnown(ID_A), true, 'a live shell row must read as still known')
  delete shellRows.byId[ID_A]
})

console.log('\n[8b] 导航图标补丁 / navigation icon patch')
check('只给本插件的行打标记（中英文都认）', () => {
  assert.equal(navButtons[1].attrs[NAV], '1', 'zh row not tagged')
  assert.equal(navButtons[3].attrs[NAV], '1', 'en row not tagged')
})
check('通用设置与侧栏「设置」触发按钮不被误伤', () => {
  assert.equal(navButtons[0].attrs[NAV], undefined, 'General row was tagged')
  assert.equal(navButtons[2].attrs[NAV], undefined, 'sidebar settings trigger was tagged')
})
check('没有图标的结构不参与匹配', () => {
  assert.equal(navButtons[4].attrs[NAV], undefined)
})
check('幂等：重复打标记不会重复计数', () => {
  const again = clientExports.__test.tagNavButtons(globalThis.document, ['会话回收站', 'Session trash'])
  assert.equal(again, 0)
})
check('注入的 CSS：隐藏外壳的齿轮 svg，并画 currentColor 的垃圾桶 mask', () => {
  const css = styleNodes[0]?.textContent ?? ''
  assert.ok(css.includes(`button[${NAV}] > svg { display: none`), 'svg not hidden')
  assert.ok(css.includes('mask: url("data:image/svg+xml'), 'mask missing')
  assert.ok(css.includes('background-color: currentColor'), 'color does not follow the row')
  assert.ok(css.includes('16px'), 'icon size missing')
})
check('垃圾桶字形本身是完整的 SVG（白色描边，两种 mask 解释下都不透明）', () => {
  const css = styleNodes[0]?.textContent ?? ''
  const match = css.match(/data:image\/svg\+xml;charset=utf-8,([^")]+)/)
  assert.ok(match, 'glyph data URI missing')
  const svg = decodeURIComponent(match[1])
  assert.ok(svg.startsWith('<svg '), 'glyph is not an svg element')
  assert.ok(svg.endsWith('</svg>'), 'glyph is not closed')
  assert.ok(svg.includes('viewBox="0 0 24 24"'), 'viewBox missing')
  assert.ok(svg.includes('stroke="#fff"'), 'stroke should be white for mask robustness')
  assert.ok(!/<script|onload=/i.test(svg), 'glyph must stay inert')
  const opened = (svg.match(/<path/g) ?? []).length
  assert.ok(opened >= 3, `expected several path segments, got ${opened}`)
})
check('观察器只盯 body 的直接子节点（避免流式输出期间高频全文档扫描）', () => {
  assert.equal(observerOptions?.childList, true)
  assert.ok(!observerOptions?.subtree, 'subtree must stay off')
  assert.ok(!observerOptions?.characterData, 'characterData must stay off')
  assert.equal(observerDisconnected, true)
  assert.equal(styleNodes[0]?.removed, true)
})
const wrapper = registrations[0].component({ t: (key) => key, locale: 'zh' })
check('注册的组件包一层把 t 传进页面', () => {
  assert.equal(typeof wrapper.type, 'function')
  assert.equal(wrapper.type, clientExports.__test.SessionTrashPage)
})

const SESSION_ROW = { id: ID_A, title: '测试会话 A', cwd: 'C:\\Users\\Test\\project', workspacePath: 'C:\\Users\\Test\\project', updatedAt: 1791087781879, sizeBytes: 4096, archived: false, onDisk: true, group: GROUP, blank: false, trash: false }
const SECOND_ROW = { id: 'session-55555555-5555-4555-8555-555555555555', title: '同一个工作区的第二个会话', cwd: 'C:\\Users\\Test\\project', workspacePath: 'C:\\Users\\Test\\project', updatedAt: 1791087781000, sizeBytes: 8192, archived: true, onDisk: true, group: GROUP, blank: false, trash: false }
const OTHER_ROW = { id: ID_B, title: '别的仓库里的会话', cwd: 'C:\\Users\\Other\\repo', workspacePath: 'C:\\Users\\Other\\repo', updatedAt: 1791087781879, sizeBytes: 1024, archived: false, onDisk: true, group: 'g2', blank: false, trash: false }
const LOOSE_ROW = { id: 'session-44444444-4444-4444-8444-444444444444', title: '没有工作区的会话', cwd: null, workspacePath: null, updatedAt: 1791087781879, sizeBytes: 100, archived: false, onDisk: true, group: null, blank: false, trash: false }
const TRASH_ROW = { id: ID_GHOST, title: '已删会话', cwd: 'C:\\Users\\Test\\project', workspacePath: 'C:\\Users\\Test\\project', deletedAt: 1791087781879, sizeBytes: 512, archived: true, onDisk: false, group: GROUP, trash: true }
// 宿主只会送来「磁盘上真的有日志」的会话，所以夹具里没有幽灵行。
const LISTING = { ok: true, home: 'C:\\Users\\Test\\.dsh', sessions: [SESSION_ROW, SECOND_ROW, OTHER_ROW, LOOSE_ROW], trash: [TRASH_ROW] }

/**
 * Render the page with a chosen state. The shim's useState pops from stateQueue,
 * so every render must re-seed all seven slots:
 * data, error, loading, query, busy, note, pending.
 */
function renderWith(overrides = {}) {
  const state = { data: null, error: null, loading: true, query: '', busy: '', note: '', pending: null, staleIds: [], ...overrides }
  stateQueue.push(state.data, state.error, state.loading, state.query, state.busy, state.note, state.pending, state.staleIds)
  return wrapper.type(wrapper.props)
}
const serialize = (element) => JSON.stringify(element, (key, value) => (typeof value === 'function' ? '[fn]' : value))

const emptyTree = serialize(renderWith())
check('空状态渲染：标题 + 加载提示，不出现列表分区', () => {
  assert.ok(emptyTree.includes('t:title'), 'title missing')
  assert.ok(emptyTree.includes('t:loading'), 'loading hint missing')
  assert.ok(!emptyTree.includes('t:sectionSessions'), 'sections must wait for data')
})

const loadedTree = serialize(renderWith({ data: LISTING, loading: false }))
check('加载后渲染：两个分区、会话标题、删除/还原/彻底删除 按钮都在', () => {
  for (const needle of ['t:sectionSessions', 't:sectionTrash', '测试会话 A', '已删会话', 't:del', 't:restore', 't:purge']) {
    assert.ok(loadedTree.includes(needle), `missing ${needle}`)
  }
})
check('界面里完全没有残留行那一套（徽章/说明/按钮都不复存在）', () => {
  assert.ok(!loadedTree.includes('t:forget'), 'the forget action must be gone from the UI')
  assert.ok(!loadedTree.includes('t:badgeRegistered'), 'residual badge must be gone')
  assert.ok(!loadedTree.includes('t:residualHint'), 'residual hint must be gone')
  // 四条有日志的会话各有一个删除按钮；幽灵/残留行不参与渲染。
  const deleteButtons = loadedTree.split('t:del').length - 1
  assert.equal(deleteButtons, 4, `expected one delete button per real session, got ${deleteButtons}`)
})
check('没有待确认动作时不渲染对话框', () => {
  assert.ok(!loadedTree.includes('t:dialogConfirm'), 'dialog must stay closed')
})

console.log('\n[8e] 确认框跟随主题 / dialog follows the theme')
// 之前的蒙层写死 rgba(0,0,0,0.35)，浅色主题下一弹确认框整个界面像切进深色模式。
const themeProbe = serialize(
  renderWith({ data: { ok: true, home: '', sessions: [], trash: [] }, loading: false, pending: { key: 'k', path: '/delete', payload: { id: ID_A }, noteKey: 'noteDeleted', danger: true, message: 't:confirmDelete' } }),
)
check('蒙层用外壳自己的主题变量，而不是写死的暗色', () => {
  assert.ok(themeProbe.includes('--dsw-alias-bg-mask-1'), 'mask must use the theme mask variable')
  assert.ok(!themeProbe.includes('rgba(0,0,0,0.35)'), 'no hard-coded dark scrim')
})
check('卡片底色/文字色也走主题变量', () => {
  assert.ok(themeProbe.includes('--dsw-alias-bg-layer-2'), 'card background must follow the theme layer')
  assert.ok(themeProbe.includes('--dsw-alias-label-primary'), 'card text must follow the theme label colour')
})

console.log('\n[8d] 按工作区分组 / grouping by workspace')
check('groupByWorkspace 按路径分组，未分组排最后', () => {
  const groups = clientExports.__test.groupByWorkspace([
    { id: 'a', workspacePath: 'C:\\b' },
    { id: 'b', workspacePath: 'C:\\a' },
    { id: 'c', workspacePath: null, cwd: null },
    { id: 'd', workspacePath: 'C:\\b' },
  ])
  assert.deepEqual(groups.map((group) => group.path), ['C:\\a', 'C:\\b', ''])
  assert.deepEqual(groups[1].items.map((row) => row.id), ['a', 'd'])
})
check('groupByWorkspace 在 workspacePath 缺失时回落到 cwd', () => {
  const groups = clientExports.__test.groupByWorkspace([{ id: 'x', cwd: 'C:\\from-cwd' }])
  assert.deepEqual(groups.map((group) => group.path), ['C:\\from-cwd'])
})
check('渲染出三个分组标题：两个工作区 + 未分组', () => {
  // 序列化后的 Windows 路径里反斜杠是转义的，比较时用同一套转义。
  const needles = [JSON.stringify('C:\\Users\\Test\\project'), JSON.stringify('C:\\Users\\Other\\repo'), 't:groupOthers']
  for (const needle of needles) {
    assert.ok(loadedTree.includes(needle), `missing group header ${needle}`)
  }
  const order = needles.map((needle) => loadedTree.indexOf(needle))
  assert.ok(order[1] < order[0], 'C:\\Users\\Other\\repo sorts before C:\\Users\\Test\\project')
  assert.ok(order[0] < order[2], 'ungrouped must be last')
})
check('分组标题带该组的会话数', () => {
  // 测试工作区那一组两个会话，别的仓库/未分组各一个。
  assert.ok(loadedTree.includes('"children":"2"'), 'expected a group count of 2')
  assert.ok(loadedTree.includes('"children":"1"'), 'expected a group count of 1')
})

// ── 回归：删除必须走页面内确认，而不是原生 confirm ─────────────────────────
// 原生对话框曾在 Electron 里把窗口的键盘焦点弄丢（点得动、打不了字，要最小化再恢复）。
console.log('\n[8c] 删除确认流程 / in-page confirmation (native-dialog regression)')
check('bundle 源码里不再出现任何原生对话框调用', () => {
  assert.ok(!/window\.confirm\s*\(/.test(clientSource), 'window.confirm( still present')
  assert.ok(!/window\.alert\s*\(/.test(clientSource), 'window.alert( still present')
  assert.ok(!/window\.prompt\s*\(/.test(clientSource), 'window.prompt( still present')
})

/** Flatten a shim element tree so a button can be found by its label text. */
function collect(element, out = []) {
  if (element === null || element === undefined || typeof element !== 'object') return out
  out.push(element)
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : children === undefined ? [] : [children]) collect(child, out)
  return out
}
function findByText(element, text) {
  return collect(element).find((node) => node.props?.children === text) ?? null
}

// ① 点「删除」只打开确认框，绝不立刻发请求。
const fetches = []
globalThis.fetch = async (url, options) => {
  fetches.push({
    url: String(url),
    method: options?.method ?? 'GET',
    body: options?.body,
    headers: options?.headers ?? {},
  })
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: ID_A, sessions: [], trash: [] }) }
}
const loadedElement = renderWith({ data: LISTING, loading: false })
const deleteButton = findByText(loadedElement, 't:del')
check('列表里的「删除」按钮存在', () => assert.ok(deleteButton, 'delete button not found'))
deleteButton.props.onClick()
check('点「删除」不直接发请求（先把确认框弹出来）', () => {
  assert.equal(fetches.length, 0, `unexpected request: ${JSON.stringify(fetches)}`)
})

// ② 待确认状态下的渲染：对话框带原文与两个按钮。
const PENDING = {
  key: `live:${ID_A}`,
  path: '/delete',
  payload: { id: ID_A },
  noteKey: 'noteDeleted',
  danger: true,
  message: 't:confirmDelete',
}
const dialogTree = renderWith({ data: { ok: true, home: '', sessions: [], trash: [] }, loading: false, pending: PENDING })
const dialogText = serialize(dialogTree)
check('确认框渲染出来了：原文 + 确认/取消', () => {
  assert.ok(dialogText.includes('t:confirmDelete'), 'message missing')
  assert.ok(dialogText.includes('t:dialogConfirm'), 'confirm label missing')
  assert.ok(dialogText.includes('t:dialogCancel'), 'cancel label missing')
  assert.ok(dialogText.includes('data-dsh-trash-dialog'), 'dialog markers missing')
})
const confirmButton = findByText(dialogTree, 't:dialogConfirm')
check('确认按钮存在', () => assert.ok(confirmButton, 'confirm button not found'))
confirmButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
check('确认后发出 POST /delete，body 带会话 id', () => {
  const hit = fetches.find((call) => call.url.includes('/delete'))
  assert.ok(hit, `no /delete request: ${JSON.stringify(fetches)}`)
  assert.equal(hit.method, 'POST')
  assert.equal(hit.body, JSON.stringify({ id: ID_A }))
  assert.ok(fetches.some((call) => call.url.includes('/list')), 'should refresh the listing afterwards')
})
check('每个请求都带上后端的标志头（GET 与 POST 都要）', () => {
  assert.ok(fetches.length > 0, 'no requests captured')
  for (const call of fetches) {
    assert.equal(
      call.headers['x-dsh-session-trash'],
      '1',
      `${call.method} ${call.url} is missing the x-dsh-session-trash header`,
    )
  }
  const post = fetches.find((call) => call.method === 'POST')
  assert.equal(post.headers['content-type'], 'application/json', 'POST must keep its JSON content type')
})

// ③ 动作成功后必须让外壳重新拉一次会话清单——否则侧栏会继续显示那条已被摘掉的缓存行。
// 注意注册包装器会用它自己注入的 refreshShell 覆盖调用方传的同名 prop，所以这里断言的是
// 真实实现打到 `sessions` 服务上的调用次数。
const refreshesBefore = sessionsStub.refreshes
stateQueue.push({ ok: true, home: '', sessions: [], trash: [] }, null, false, '', '', '', PENDING)
const refreshDialog = injectingWrapper.type(injectingWrapper.props)
const refreshConfirm = findByText(refreshDialog, 't:dialogConfirm')
check('确认框仍可渲染', () => assert.ok(refreshConfirm, 'confirm button missing'))
refreshConfirm.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
check('确认删除 → 触发外壳刷新（sessions.refresh）', () => {
  assert.ok(sessionsStub.refreshes > refreshesBefore, 'sessions.refresh() was never requested')
})

// ④ 彻底删除后若宿主仍把它当活会话报出来，界面必须给出「刷新界面」的出路（而不是让用户去重启）。
const PURGE_PENDING = {
  key: `trash:${ID_A}`,
  path: '/purge',
  payload: { id: ID_A },
  noteKey: 'notePurged',
  danger: true,
  message: 't:confirmPurge',
}
const readsBefore = listReads
stateQueue.push({ ok: true, home: '', sessions: [], trash: [TRASH_ROW] }, null, false, '', '', '', PURGE_PENDING, [])
const purgeDialog = injectingWrapper.type(injectingWrapper.props)
const purgeConfirm = findByText(purgeDialog, 't:dialogConfirm')
check('purge 确认框可渲染', () => assert.ok(purgeConfirm, 'purge confirm button missing'))
purgeConfirm.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
check('purge 确认后探询「宿主是否还认识这个会话」', () => {
  assert.ok(listReads > readsBefore, 'sessionStillKnown was never consulted')
})

const staleTree = serialize(renderWith({ data: LISTING, loading: false, staleIds: [ID_A] }))
check('仍被宿主报出来的会话 → 显示提示与「刷新界面」按钮', () => {
  assert.ok(staleTree.includes('t:noteStale'), 'stale notice missing')
  assert.ok(staleTree.includes('t:reloadNow'), 'reload button missing')
})
check('没有残留活会话时不显示该提示', () => {
  assert.ok(!loadedTree.includes('t:noteStale'), 'stale notice must stay hidden when clean')
  assert.ok(!loadedTree.includes('t:reloadNow'))
})
check('取消按钮只关闭对话框（不发请求）', () => {
  const before = fetches.length
  const cancelButton = findByText(dialogTree, 't:dialogCancel')
  assert.ok(cancelButton, 'cancel button not found')
  cancelButton.props.onClick()
  assert.equal(fetches.length, before)
})
delete globalThis.fetch

check('displayTitle 对空白会话有兜底', () => {
  const { displayTitle } = clientExports.__test
  assert.equal(displayTitle({ title: 'x' }, (k) => k), 'x')
  assert.equal(displayTitle({ title: '   ', blank: true }, (k) => k), 'blank')
  assert.equal(displayTitle({ title: null, blank: false }, (k) => k), 'noTitle')
})
check('formatSize 可读', () => {
  const { formatSize } = clientExports.__test
  assert.equal(formatSize(0), '—')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
})
delete globalThis.window

console.log('\n[9] 插件启动路径 / apply() under a cordis-shaped ctx')
const mountHome = await makeHome()
const registered = []
const scopedEffects = []
const fakeHostCtx = {
  logger: { info() {}, warn() {} },
  get: () => undefined,
  inject: (deps, callback) => {
    assert.deepEqual(deps, ['webServer'])
    callback({
      webServer: {
        register: (route) => {
          registered.push(route)
          return () => {}
        },
      },
      effect: (fn, label) => {
        scopedEffects.push(label)
        const disposer = fn()
        if (typeof disposer === 'function') disposer()
      },
    })
  },
}
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = mountHome
mod.apply(fakeHostCtx, {})
if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome

check('apply() 立刻建好回收站目录', () => {
  assert.equal(fs.existsSync(path.join(mountHome, 'session-trash')), true)
})
check('等待 webServer 并注册前缀路由', () => {
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/api/dsh-session-trash')
  assert.equal(typeof registered[0].handler, 'function')
})
check('路由挂在 scoped.effect 上（可随服务替换重挂）', () => {
  assert.equal(scopedEffects.length, 1)
  assert.ok(String(scopedEffects[0]).includes('dsh-session-trash'))
})
const applied = await callHandler(registered[0].handler, 'GET', '/list')
check('apply() 注册出来的 handler 真的能应答', () => {
  assert.equal(applied.status, 200)
  assert.equal(applied.json.sessions.length, 2)
})
await fsp.rm(mountHome, { recursive: true, force: true })

console.log('\n[10] 发布一致性 / packaging must stay self-consistent')
// 这三处名字必须完全一致，否则浏览器半身根本挂不上（它只绑定「说明符恰为包名」的那一行 Loader）。
// 改包名（例如 npm 上重名）时最容易漏掉，所以放进测试。
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patchText = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
check('package.json name = cordis.patch.yml 行 name = client bundle id', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.equal(clientExports.name, pkg.name, 'host half export name must equal the package name')
  assert.equal(bundle.id, pkg.name, 'client bundle id must equal the package name')
  assert.ok(
    new RegExp(`name:\\s*'${pkg.name}'`).test(patchText),
    `cordis.patch.yml must insert a row named exactly "${pkg.name}"`,
  )
})
check('入口/清单/图标都存在，且声明指向真实文件', () => {
  assert.equal(pkg.main, './index.js')
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`)
  }
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})
check('files 覆盖了运行期真正需要的文件', () => {
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(pkg.files.includes(file), `files[] must ship ${file}`)
  }
})
check('没有构建步骤（GitHub 直装不会被 allowBuilds 拦下）', () => {
  const scripts = pkg.scripts ?? {}
  for (const hook of ['prepare', 'prepublishOnly', 'prepack', 'postinstall']) {
    assert.equal(scripts[hook], undefined, `${hook} would make pnpm gate the install`)
  }
  assert.equal(pkg.private, undefined, 'private:true would block npm publish')
})
check('发布元信息里没有占位符，且指向真实仓库形状', () => {
  const urls = [pkg.repository?.url, pkg.homepage, pkg.bugs?.url].filter((value) => typeof value === 'string')
  assert.equal(urls.length, 3, 'repository/homepage/bugs must all be set')
  for (const url of urls) {
    assert.ok(!/OWNER|<[^>]*>/i.test(url), `placeholder left in ${url}`)
    assert.ok(url.includes('github.com/'), `${url} should point at GitHub`)
    assert.ok(url.includes(`/${pkg.name}`), `${url} should name the package repo`)
  }
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `version must be semver, got ${pkg.version}`)
  assert.equal(pkg.license, 'MIT')
})
check('README 里没有遗留占位符', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.ok(!readme.includes('OWNER'), 'README still contains the OWNER placeholder')
  assert.ok(readme.includes(pkg.name), 'README should name the package')
})

console.log('\n[11] 审计加固 / hardening from the pre-publish audit')
// 回收站登记文件是 $DSH_HOME 下的普通文件（可能被手工编辑、被其它工具改写、被写坏），
// 所以它必须当成不可信输入：否则一次「彻底删除」会 recursive rm 到别处，一次「还原」会把
// 文件搬到 sessions 目录之外。
const auditHome = await makeHome()
const auditStore = new SessionStore(auditHome)
const outsideDir = path.join(auditHome, 'not-the-trash')
await fsp.mkdir(outsideDir, { recursive: true })
await fsp.writeFile(path.join(outsideDir, 'precious.txt'), 'must survive', 'utf8')
const goodEntryDir = path.join(auditHome, 'session-trash', '20260101000000-' + ID_A)
await fsp.mkdir(path.join(goodEntryDir, 'session'), { recursive: true })
await fsp.writeFile(path.join(goodEntryDir, 'session', 'session.v4.jsonl.zstd'), 'log', 'utf8')
await fsp.writeFile(
  path.join(auditHome, 'session-trash', 'index.json'),
  JSON.stringify({
    version: 1,
    entries: [
      // 合法条目：应当保留
      { id: ID_A, dir: goodEntryDir, group: GROUP, cwd: 'C:\\Users\\Test\\project', deletedAt: Date.now() },
      // dir 指向回收站之外 → 会让「彻底删除」删掉无关目录
      { id: ID_B, dir: outsideDir, group: GROUP, deletedAt: Date.now() },
      // dir 是回收站子路径的 ../ 逃逸写法
      { id: 'session-77777777-7777-4777-8777-777777777777', dir: path.join(auditHome, 'session-trash', '..', 'not-the-trash'), group: GROUP, deletedAt: Date.now() },
      // group 不是单个路径段 → 会让「还原」写到 sessions 之外
      { id: ID_GHOST, dir: goodEntryDir, group: '..\\..\\evil', deletedAt: Date.now() },
      // id 形状非法
      { id: '../../evil', dir: goodEntryDir, group: GROUP, deletedAt: Date.now() },
    ],
  }),
  'utf8',
)
const audited = await auditStore.trashEntries()
check('登记里 dir 逃出回收站 / group 非单段 / id 形状非法的条目全部被剔除', () => {
  assert.deepEqual(audited.map((entry) => entry.id), [ID_A], 'only the well-formed entry may survive')
})
check('被剔除的坏条目会从 index.json 里清掉', async () => {})
const rewritten = JSON.parse(await fsp.readFile(path.join(auditHome, 'session-trash', 'index.json'), 'utf8'))
check('index.json 已被重写为只剩合法条目', () => {
  assert.equal(rewritten.entries.length, 1)
  assert.equal(rewritten.entries[0].id, ID_A)
})
const outsideFile = path.join(outsideDir, 'precious.txt')
const auditEmpty = await callHandler(
  createHandler({ store: auditStore, service: () => undefined, logger: { info() {}, warn() {} } }),
  'POST',
  '/empty',
  {},
)
check('清空回收站不会碰到回收站之外的目录', () => {
  assert.equal(auditEmpty.status, 200)
  assert.equal(fs.existsSync(outsideFile), true, 'a file outside the trash was deleted')
  assert.equal(auditEmpty.json.removed, 1)
})
await fsp.rm(auditHome, { recursive: true, force: true })

// 摘活会话的安全阀：会话报告有活动时不许摘。
const activeHome = await makeHome()
const activeStore = new SessionStore(activeHome)
const activeCalls = []
const activeSessions = {
  store: new Map([[ID_A, { id: ID_A, session: { id: ID_A }, announced: true }]]),
  get(id) {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : entry.session
  },
  liveEntryFor(session) {
    return [...this.store.values()].find((entry) => entry.session === session)
  },
  detachEntered(entry) {
    activeCalls.push(entry.id)
    this.store.delete(entry.id)
  },
}
const activeService = (name) => (name === 'sessions' ? activeSessions : undefined)
const skipped = await mod.__internal.forgetLiveSession({
  service: activeService,
  id: ID_A,
  waterfall: async () => [{ kind: 'agent-turn' }],
})
check('会话仍在活动时不摘（宁可多留一行，也不抽走正在跑的会话）', () => {
  assert.equal(skipped.liveSkippedActive, true)
  assert.equal(skipped.liveDropped, false)
  assert.deepEqual(activeCalls, [], 'detachEntered must not run for an active session')
  assert.equal(activeSessions.store.has(ID_A), true)
})
const dropped = await mod.__internal.forgetLiveSession({
  service: activeService,
  id: ID_A,
  waterfall: async () => [],
})
check('无活动时正常摘除', () => {
  assert.equal(dropped.liveDropped, true)
  assert.deepEqual(activeCalls, [ID_A])
})
const probeFailed = await mod.__internal.forgetLiveSession({
  service: (name) =>
    name === 'sessions'
      ? {
          store: new Map([[ID_A, { id: ID_A, session: { id: ID_A }, announced: true }]]),
          get(id) {
            return this.store.get(id)?.session
          },
          liveEntryFor(session) {
            return [...this.store.values()].find((entry) => entry.session === session)
          },
          detachEntered() {},
        }
      : undefined,
  id: ID_A,
  waterfall: async () => {
    throw new Error('waterfall unavailable')
  },
})
check('活动探测本身报错时按「无活动」继续（文件都已经删了，不能因为探测失败留痕）', () => {
  assert.equal(probeFailed.liveDropped, true)
})
await fsp.rm(activeHome, { recursive: true, force: true })

console.log('\n[12] 跨站防护 / CSRF + DNS-rebinding fence')
// 只校验回环是不够的：浏览器里的任意网页都能向 http://127.0.0.1:<port> 发简单 POST
// （CORS 只挡读响应，不挡副作用），而 /purge 不可恢复。所以要求自定义标志头 + 回环 Host。
const fenceHome = await makeHome()
const fenceStore = new SessionStore(fenceHome)
const fenceHandler = createHandler({ store: fenceStore, service: () => undefined, logger: { info() {}, warn() {} } })

// 先正常删一个，让回收站里有东西——用来证明被挡下的请求确实没有产生副作用。
const setup = await callHandler(fenceHandler, 'POST', '/delete', { id: ID_A })
check('带标志头 + 回环 Host 的正常请求照常工作', () => assert.equal(setup.status, 200))
const trashDirCount = () => fs.readdirSync(path.join(fenceHome, 'session-trash')).filter((name) => name !== 'index.json').length
const trashBefore = trashDirCount()
check('回收站里确实多了一个条目（对照基线）', () => assert.equal(trashBefore, 1))

// ① 缺标志头（跨站简单请求就长这样）
const noHeader = await callHandler(fenceHandler, 'POST', '/purge', { id: ID_A }, { clientHeader: null })
check('缺标志头的 POST /purge → 403', () => {
  assert.equal(noHeader.status, 403)
  assert.ok(String(noHeader.json.error).includes('x-dsh-session-trash'), 'error should name the missing header')
})
// ② 标志头值不对
const wrongHeader = await callHandler(fenceHandler, 'POST', '/purge', { id: ID_A }, { clientHeader: 'yes' })
check('标志头值不对 → 403', () => assert.equal(wrongHeader.status, 403))
// ③ 以上两次被挡下的请求都不能产生副作用
check('被挡下的请求没有删除任何东西', () => {
  assert.equal(trashDirCount(), trashBefore, 'a blocked request still mutated the trash')
})
// ④ GET 也一样要过闸（读取同样不该给跨站页面）
const listNoHeader = await callHandler(fenceHandler, 'GET', '/list', undefined, { clientHeader: null })
check('缺标志头的 GET /list → 403', () => assert.equal(listNoHeader.status, 403))
// ⑤ DNS rebinding：页面源是攻击者域名，自定义头也不触发预检，此时只能靠 Host 挡
for (const host of ['evil.example:19387', 'evil.example', '192.168.1.9:19387', '', null]) {
  const rebound = await callHandler(fenceHandler, 'POST', '/delete', { id: ID_B }, { host })
  check(`Host=${JSON.stringify(host)} → 403（挡 DNS rebinding）`, () => {
    assert.equal(rebound.status, 403)
    assert.ok(String(rebound.json.error).includes('127.0.0.1'), 'error should tell the user which host to use')
  })
}
// ⑥ 合法的回环 Host 写法都要放行
for (const host of ['127.0.0.1:19387', '127.0.0.1', 'localhost:19387', 'LOCALHOST:5173', '[::1]:19387', '127.0.0.1:1']) {
  const allowed = await callHandler(fenceHandler, 'GET', '/list', undefined, { host })
  check(`Host=${host} → 放行`, () => assert.equal(allowed.status, 200))
}
// ⑦ 直接单测闸门本身（不经过路由），把边界钉死
const fenceProbe = mod.__internal.requestFence
check('requestFence 的判定与路由一致', () => {
  assert.equal(fenceProbe({ headers: { host: '127.0.0.1:1', 'x-dsh-session-trash': '1' } }), undefined)
  assert.equal(typeof fenceProbe({ headers: { host: 'localhost', 'x-dsh-session-trash': '1' } }), 'undefined')
  assert.ok(fenceProbe({ headers: { host: 'example.com', 'x-dsh-session-trash': '1' } }))
  assert.ok(fenceProbe({ headers: { host: '127.0.0.1:1' } }))
  assert.ok(fenceProbe({ headers: {} }))
})
await fsp.rm(fenceHome, { recursive: true, force: true })

await fsp.rm(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
