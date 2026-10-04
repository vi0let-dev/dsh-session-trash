/**
 * dsh-session-trash — Host half.
 *
 * DeepSeek Harness 的官方「归档」只把会话移出侧栏，磁盘上的日志会永久堆积；桌面端
 * 也没有任何删除会话的入口。本插件补上这件事，并且默认是**可逆**的：
 *
 *   删除    → 先走官方归档通道把会话移出侧栏，再把它的日志目录移进
 *             `$DSH_HOME/session-trash/`，同时把投影缓存一并带走（还原时一起回来）。
 *   还原    → 文件归位 + 解除归档，会话立刻回到侧栏原来的工作区分组。
 *   彻底删除 → 清掉回收站里的目录与登记，不可恢复。
 *
 * 除了「删除时归档」「还原时解除归档」，本插件**不写任何记账**——不摘工作区账本，也不在
 * 彻底删除时去动归档标记。原因是实测的：浏览器投影把工作区条目与归档集合缓存在内存里，
 * 运行期去改这两处会触发一次重绘，把缓存里那条「没有数据的行」重新画到侧栏的「未分组」
 * 下，而且会一直留到下次重启。归档标记留在那里反而让侧栏继续把那个 id 当隐藏项处理。
 *
 * 代价是账本/归档集合里会留下没有日志的 id（DSH 自己就带着这种 id 运行，启动只打一条
 * warn 日志："filtered session ... from membership: session header is missing"）。
 * 要清就用 tools/prune-ledger.mjs 在 DSH 停止时离线处理；这个界面里不提供运行期清理。
 *
 * @module index.js
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-session-trash'

/**
 * 唯一硬需求是不存在的：没有 webServer 时路由不挂载（浏览器半身显示一个错误），
 * 没有 workspaceRegistry / sessionPersistence 时退化为纯文件系统模式。
 * 因此这里不 inject 任何东西——组合缺什么就少一个能力，而不是整个插件不激活。
 */
export const inject = []

/** 路由前缀。webServer 按最长前缀派发，这个前缀比 `/api` 更长，因此归本插件处理。 */
const ROUTE_PREFIX = '/api/dsh-session-trash'

/** 会话 id 的形状：`session-<uuid>` 或裸 `<uuid>`；用于挡掉任何路径穿越。 */
const SESSION_ID = /^(session-)?[0-9a-fA-F-]{4,64}$/

/** 会话日志目录里的文件名形如 `session.v4.jsonl.zstd`。 */
const SESSION_LOG = /^session\..*\.jsonl(\.zstd)?$/

/** 一次 POST body 的上限，防止畸形请求把内存吃满。 */
const MAX_BODY = 64 * 1024

/** DSH_HOME：环境变量优先（桌面端与 CLI 都用它），否则退回 `~/.dsh`。 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** 把毫秒时间戳渲染成能进 JSON 的原始值，坏值一律 null。 */
function safeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/** 目录体积，用于在列表里显示「这个会话占多大」。失败不影响主流程。 */
async function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await directorySize(target)
      else total += (await fsp.stat(target)).size
    } catch {
      /* 读取失败按 0 计 */
    }
  }
  return total
}

/** 跨盘 rename 会失败，退化成复制 + 删除。 */
async function moveTree(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  await fsp.cp(from, to, { recursive: true, force: true })
  await fsp.rm(from, { recursive: true, force: true })
}

/** 递归删除，目标不存在也算成功。 */
async function removeTree(target) {
  await fsp.rm(target, { recursive: true, force: true })
}

/** 读一个 JSON 文件，任何失败都退回 undefined（坏文件不该让整页打不开）。 */
async function readJsonFile(file) {
  try {
    // 去掉可能存在的 BOM：DSH 自己写文件不带 BOM，但用户用某些编辑器改过之后会带上，
    // 而 JSON.parse 会直接拒绝——那会表现为「标题全空」「回收站突然空了」这种莫名其妙的现象。
    const text = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 原子写 JSON：先写临时文件再改名，避免半截文件。 */
async function writeJsonFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(temp, file)
}

/** 逐段读 POST body 并解析 JSON。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 只回答本机回环连接：这是一条能让会话落盘的破坏性路由。 */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** 会话 id 的规范形状；回收站登记里只接受这一种。 */
const TRASH_ID = /^session-[0-9a-fA-F-]{4,64}$/

/** 分组名必须是单个路径段（不能有分隔符，也不能是 . / ..）。 */
function isSafeSegment(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

/** child 是否真的落在 parent 目录里面（用于挡掉登记文件被改坏 / 被人手工编辑后的路径穿越）。 */
function isInside(parent, child) {
  const base = path.resolve(parent)
  const target = path.resolve(child)
  const rel = path.relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 会话仓库：所有磁盘布局的知识都收在这里。
 *
 * 布局（DSH 0.2.0-rc.2 实测）：
 *   `$DSH_HOME/sessions/<cwd 转义后的组名>/session-<uuid>/session.v4.jsonl.zstd`
 *   `$DSH_HOME/storages/session_projcache/sessions/session-<uuid>.json`（标题与 cwd）
 */
class SessionStore {
  constructor(home) {
    this.home = home
    this.sessionsRoot = path.join(home, 'sessions')
    this.projCacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
    this.trashRoot = path.join(home, 'session-trash')
    this.trashIndex = path.join(this.trashRoot, 'index.json')
  }

  /** 磁盘上每个会话的所在目录与所属分组，key 为去掉 `session-` 前缀的 uuid。 */
  async scanDisk() {
    const found = new Map()
    let groups
    try {
      groups = await fsp.readdir(this.sessionsRoot, { withFileTypes: true })
    } catch {
      return found
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue
      const groupDir = path.join(this.sessionsRoot, group.name)
      let entries
      try {
        entries = await fsp.readdir(groupDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const key = entry.name.replace(/^session-/, '')
        const dir = path.join(groupDir, entry.name)
        // 记录日志文件是否已物化：空会话目录（尚未 flush 的日志）在侧栏里也是不可见的。
        let materialized = false
        try {
          materialized = (await fsp.readdir(dir)).some((file) => SESSION_LOG.test(file))
        } catch {
          /* 读不到就按未物化处理 */
        }
        found.set(key, { id: entry.name, key, group: group.name, dir, materialized })
      }
    }
    return found
  }

  /** 从投影缓存里取标题与 cwd —— 与侧栏显示同源，不需要解压日志。 */
  async readProjection(id) {
    const record = await readJsonFile(path.join(this.projCacheRoot, `${id}.json`))
    const rows = record?.record?.rows
    const identity = record?.record?.identity
    const title = rows?.title?.val
    return {
      title: typeof title === 'string' && title.trim() !== '' ? title : null,
      cwd: typeof identity?.cwd === 'string' ? identity.cwd : null,
      blank: rows?.sessionListMetadata?.val?.blank === true,
      createdAt: safeTime(identity?.createdAt),
    }
  }

  async trashEntries() {
    const index = await readJsonFile(this.trashIndex)
    const raw = Array.isArray(index?.entries) ? index.entries : []
    const entries = []
    for (const entry of raw) {
      // 登记文件只应由本插件写入，但它是 $DSH_HOME 下的普通文件（可能被手工编辑、被工具改写、
      // 被写坏）。所以每一项都当成**不可信输入**校验：id 必须是会话 id 形状、分组必须是单个
      // 路径段、目录必须真的落在回收站目录里。否则一次「彻底删除」就会 recursive rm 别处，
      // 一次「还原」就会把文件搬到 sessions 目录之外。
      if (typeof entry?.id !== 'string' || !TRASH_ID.test(entry.id)) continue
      if (typeof entry?.dir !== 'string' || !isInside(this.trashRoot, entry.dir)) continue
      if (entry.group !== undefined && entry.group !== null && !isSafeSegment(entry.group)) continue
      try {
        await fsp.access(entry.dir)
        entries.push(entry)
      } catch {
        /* 目录已不存在：连同登记一起丢掉 */
      }
    }
    if (entries.length !== raw.length) await this.writeTrash(entries)
    return entries
  }

  async writeTrash(entries) {
    await writeJsonFile(this.trashIndex, { version: 1, entries })
  }

  /** 把一次删除记进回收站登记。 */
  async recordTrash(entry) {
    const entries = await this.trashEntries()
    entries.unshift(entry)
    await this.writeTrash(entries)
  }

  async dropTrash(id) {
    const entries = await this.trashEntries()
    await this.writeTrash(entries.filter((entry) => entry.id !== id))
  }

  /** 会话的「持久化份」：日志目录 + 投影缓存，两处一起搬才叫完整删除。 */
  projectionPath(id) {
    return path.join(this.projCacheRoot, `${id}.json`)
  }
}

/**
 * 组装 HTTP 处理器。
 *
 * 每个请求都重新解析服务，因为 cordis 的服务可以被替换（例如 profile 重组），
 * 启动时抓一次引用会拿到过期的对象。
 */
function createHandler({ store, service, logger, waterfall }) {
  return async function handler(req, res) {
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    }

    if (!isLoopback(req)) return send(403, { error: '仅允许本机访问' })

    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && route === '/list') return send(200, await buildListing({ store, service }))

      const body = method === 'POST' ? await readJson(req) : {}
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (method === 'POST' && route !== '/empty' && !SESSION_ID.test(id)) {
        return send(400, { error: '会话 id 不合法' })
      }

      if (method === 'POST' && route === '/delete') return send(200, await deleteSession({ store, service, id }))
      if (method === 'POST' && route === '/restore') return send(200, await restoreSession({ store, service, id }))
      if (method === 'POST' && route === '/purge')
        return send(200, await purgeSession({ store, service, id, logger, waterfall }))
      if (method === 'POST' && route === '/empty') {
        const entries = await store.trashEntries()
        let detachedFrom = 0
        let unarchived = 0
        let liveDropped = 0
        for (const entry of entries) {
          await removeTree(entry.dir)
          const cleanup = await detachEverywhere({ service, id: entry.id })
          detachedFrom += cleanup.detachedFrom
          if (cleanup.unarchived === true) unarchived++
          if ((await forgetLiveSession({ service, id: entry.id, logger, waterfall })).liveDropped === true) liveDropped++
        }
        await store.writeTrash([])
        return send(200, { ok: true, removed: entries.length, detachedFrom, unarchived, liveDropped })
      }
      return send(404, { error: `未知路由 ${method} ${route}` })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      logger?.warn?.(`dsh-session-trash: ${method} ${route} failed: ${error?.message ?? error}`)
      return send(status, { error: error?.message ?? String(error) })
    }
  }
}

/** 带 HTTP 状态码的错误，处理器直接透出。 */
function fail(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 读取官方服务；缺服务时返回 undefined，调用方退回文件系统模式。 */
function optional(service, name) {
  try {
    return service(name)
  } catch {
    return undefined
  }
}

/**
 * 把一个 id 从工作区账本（`detachSession`）与归档集合（`unarchiveSession`）里都摘掉，
 * 走官方写路径，不动任何文件。
 *
 * **必须和浏览器半身的 `sessions.refresh()` 配对使用**：只做这一步，浏览器投影会拿缓存里
 * 那条已经没有数据的行重画一次，于是侧栏「未分组」下冒出一行、或在工作区里以「已归档」
 * 的样子挂一行，都要等到下次刷新才消失。删完立刻让外壳重新拉一次会话清单（见 client.js
 * 的 refreshShell），那一行才会真正消失。
 */
async function detachEverywhere({ service, id }) {
  const registry = optional(service, 'workspaceRegistry')
  if (!registry) return { detachedFrom: 0, unarchived: false, supported: false }
  const key = String(id).replace(/^session-/, '')

  let detachedFrom = 0
  const workspaces = typeof registry.list === 'function' ? registry.list() ?? [] : []
  const byId = new Map(workspaces.map((workspace) => [String(workspace?.id ?? ''), workspace]))
  for (const workspace of workspaces) {
    // 读原始记录而不是公开的 getter：日志已经消失时 getter 会把这个 id 过滤掉，而账本里还在。
    const raw = Array.isArray(workspace?.record?.sessionIds) ? workspace.record.sessionIds : workspace?.sessionIds
    const owns = (raw ?? []).some((entry) => String(entry).replace(/^session-/, '') === key)
    if (!owns) continue
    const entity = byId.get(String(workspace?.id ?? ''))
    if (!entity || typeof entity.detachSession !== 'function') continue
    await entity.detachSession(String(id))
    detachedFrom++
  }

  let unarchived = false
  const archivedNow = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []
  const wasArchived = archivedNow.some((entry) => String(entry).replace(/^session-/, '') === key)
  if (wasArchived && typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(String(id))
    unarchived = true
  }
  return { detachedFrom, unarchived, supported: true }
}

/**
 * 让**宿主**忘掉一个还活着的会话。
 *
 * 这是「彻底删除后侧栏还挂着它」的最后一块拼图。会话在宿主里由会话表（`ctx.sessions`）持有：
 * 客户端 retain 的那些（最近打开过、正在跑、或仍挂在某个视图上）会一直留在表里，于是
 * `session.list` 一直把它报出来——工作区归属已经摘掉，它就落在「未分组」下。实测：刷新页面
 * **没用**（客户端重连后宿主照样报它），只有重启宿主才会释放。
 *
 * 这里用会话表自己的移除原语把这一条摘掉：`liveEntryFor` 取到这条 entry，`detachEntered`
 * 从 store 里删除它（并给已 announce 的会话发出 `session/disposed`）。该原语本身是幂等的——
 * store 里已经不是那条 entry 就直接返回，所以将来持有它的那个 fiber 卸载时再调一次也不会出错。
 *
 * 安全阀：先问一次 `workspace/session-activity` 瀑布（与官方归档用的是同一个判据），
 * 只要还有活动就**不摘**——宁可让那一行多留一会儿，也不在后台把一个正在跑任务的会话从表里抽走。
 */
async function forgetLiveSession({ service, id, logger, waterfall }) {
  const sessions = optional(service, 'sessions')
  if (
    !sessions ||
    typeof sessions.get !== 'function' ||
    typeof sessions.liveEntryFor !== 'function' ||
    typeof sessions.detachEntered !== 'function'
  ) {
    return { liveDropped: false, liveSupported: false }
  }
  try {
    const session = sessions.get(String(id))
    if (session === undefined) return { liveDropped: false, liveSupported: true }
    const entry = sessions.liveEntryFor(session)
    if (entry === undefined) return { liveDropped: false, liveSupported: true }

    if (typeof waterfall === 'function') {
      try {
        const activity = await waterfall('workspace/session-activity', { sessionId: String(id) }, () => Promise.resolve([]))
        if (Array.isArray(activity) && activity.length > 0) {
          return { liveDropped: false, liveSupported: true, liveSkippedActive: true }
        }
      } catch (error) {
        logger?.warn?.(`dsh-session-trash: 活动探测失败，按「无活动」继续: ${error?.message ?? error}`)
      }
    }

    sessions.detachEntered(entry)
    return { liveDropped: true, liveSupported: true }
  } catch (error) {
    logger?.warn?.(`dsh-session-trash: 无法从会话表里摘掉 ${id}: ${error?.message ?? error}`)
    return { liveDropped: false, liveSupported: true }
  }
}

/**
 * 组装列表：只列**磁盘上真的有日志**的会话（外加回收站里的条目）。
 *
 * 刻意不把工作区账本里的残留 id 变成行：那种 id 没有日志、没有任何可执行的操作，列出来只是
 * 把 DSH 自己的记账残留混进一个「会话管理」界面里（用户明确要求不要这种「合二为一」）。
 * 账本残留由 DSH 自己带着（启动时只会打一条 warn），要清就用 tools/prune-ledger.mjs 离线处理。
 *
 * 本函数是**纯读**的：不改账本、不改归档集合。
 */
async function buildListing({ store, service }) {
  const disk = await store.scanDisk()
  const trash = await store.trashEntries()
  const registry = optional(service, 'workspaceRegistry')
  const persistence = optional(service, 'sessionPersistence')

  // 归档标记只用来给行加个「已归档」标注（用户可能在侧栏手动归档过）。
  const archived = new Set()
  if (registry && Array.isArray(registry.archivedSessionIds)) {
    for (const id of registry.archivedSessionIds) archived.add(String(id).replace(/^session-/, ''))
  }

  // 持久化服务的快照能补上磁盘扫描看不到的信息（例如刚创建、还没 flush 的会话）。
  const snapshots = new Map()
  if (persistence && typeof persistence.list === 'function') {
    try {
      for (const snapshot of (await persistence.list()) ?? []) {
        const header = snapshot?.header ?? snapshot
        const raw = header?.id ?? snapshot?.id
        if (typeof raw !== 'string') continue
        snapshots.set(raw.replace(/^session-/, ''), { header, sizeBytes: snapshot?.sizeBytes })
      }
    } catch {
      /* 快照失败不影响磁盘扫描结果 */
    }
  }

  // 回收站里的会话不再出现在「全部会话」，否则同一个会话会同时显示在两处。
  const trashedKeys = new Set(trash.map((entry) => String(entry.id).replace(/^session-/, '')))
  const keys = new Set([...disk.keys(), ...snapshots.keys()])
  const sessions = []
  for (const key of keys) {
    if (trashedKeys.has(key)) continue
    const local = disk.get(key)
    const snapshot = snapshots.get(key)
    const id = local?.id ?? snapshot?.header?.id ?? `session-${key}`
    const projection = local ? await store.readProjection(id) : { title: null, cwd: null, blank: false, createdAt: null }
    let sizeBytes = safeTime(snapshot?.sizeBytes) ?? 0
    let updatedAt = safeTime(snapshot?.header?.updatedAt)
    if (local) {
      sizeBytes = await directorySize(local.dir)
      try {
        updatedAt = Math.trunc((await fsp.stat(local.dir)).mtimeMs)
      } catch {
        /* 保留快照时间 */
      }
    }
    sessions.push({
      id,
      title: projection.title ?? (typeof snapshot?.header?.title === 'string' ? snapshot.header.title : null),
      cwd: projection.cwd ?? (typeof snapshot?.header?.cwd === 'string' ? snapshot.header.cwd : null) ?? null,
      blank: projection.blank === true,
      createdAt: projection.createdAt ?? safeTime(snapshot?.header?.createdAt),
      updatedAt,
      sizeBytes,
      archived: archived.has(key),
      onDisk: local !== undefined,
      // 分组依据就是会话自己的工作目录，与侧栏的分组口径一致。
      workspacePath: projection.cwd ?? (typeof snapshot?.header?.cwd === 'string' ? snapshot.header.cwd : null) ?? null,
      group: local?.group ?? null,
      trash: false,
    })
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  const trashItems = []
  for (const entry of trash) {
    trashItems.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      // 删除时记下的工作区路径就是回收站里的分类依据；没有就归到未分组。
      workspacePath: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : null,
      deletedAt: safeTime(entry.deletedAt),
      sizeBytes: safeTime(entry.sizeBytes) ?? 0,
      archived: true,
      onDisk: false,
      group: typeof entry.group === 'string' ? entry.group : null,
      trash: true,
    })
  }

  return {
    ok: true,
    home: store.home,
    capabilities: {
      registry: registry !== undefined,
      persistence: persistence !== undefined,
    },
    sessions,
    trash: trashItems,
  }
}

/** 定位会话目录；找不到就抛 404。 */
async function requireDisk(store, id) {
  const disk = await store.scanDisk()
  const local = disk.get(String(id).replace(/^session-/, ''))
  if (!local) throw fail(404, '磁盘上找不到这个会话的日志目录（可能已被删除）')
  return local
}

/**
 * 删除一个会话：归档（移出侧栏）→ 日志目录与投影缓存进回收站。
 *
 * 归档是官方能力，同时充当「这个会话正忙吗」的判据：workspaceRegistry 会先问
 * `workspace/session-activity` 瀑布，有活动就抛 WorkspaceActiveSessionError，
 * 我们转成 409 拒绝——正在跑或等待交互的会话绝不动。
 */
async function deleteSession({ store, service, id }) {
  const local = await requireDisk(store, id)
  const registry = optional(service, 'workspaceRegistry')
  let archivedByUs = false

  // 标题与 cwd 必须在搬走投影缓存之前读，否则回收站里的条目会只剩一个 id。
  const projectionInfo = await store.readProjection(local.id)

  if (registry && typeof registry.archiveSession === 'function') {
    try {
      const already = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(local.id)
      await registry.archiveSession(local.id)
      archivedByUs = !already
    } catch (error) {
      const reason = error?.name ?? ''
      if (reason === 'WorkspaceActiveSessionError') {
        throw fail(409, '这个会话正在运行或等待交互，先停掉它再删除')
      }
      if (reason === 'WorkspaceUnknownSessionError') {
        // 登记里不认识它，但磁盘上有日志：继续删文件，只是没有归档这一步。
      } else {
        throw fail(409, `归档失败，已放弃删除：${error?.message ?? error}`)
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const entryDir = path.join(store.trashRoot, `${stamp}-${local.id}`)
  const projection = store.projectionPath(local.id)
  const projectionMoved = await fsp
    .access(projection)
    .then(() => true)
    .catch(() => false)

  try {
    await moveTree(local.dir, path.join(entryDir, 'session'))
    if (projectionMoved) await moveTree(projection, path.join(entryDir, 'projcache.json'))
  } catch (error) {
    // 半途失败要把归档退回去，否则会话既不在侧栏也不在回收站。
    if (archivedByUs && typeof registry?.unarchiveSession === 'function') {
      await registry.unarchiveSession(local.id).catch(() => {})
    }
    await removeTree(entryDir).catch(() => {})
    throw fail(500, `移动会话文件失败：${error?.message ?? error}`)
  }

  await store.recordTrash({
    id: local.id,
    title: projectionInfo.title,
    cwd: projectionInfo.cwd,
    group: local.group,
    deletedAt: Date.now(),
    dir: entryDir,
    sizeBytes: await directorySize(entryDir),
  })

  return { ok: true, id: local.id, trashed: entryDir }
}

/** 从回收站还原：文件归位 → 解除归档，会话回到侧栏原来的分组。 */
async function restoreSession({ store, service, id }) {
  const entries = await store.trashEntries()
  const key = String(id).replace(/^session-/, '')
  const entry = entries.find((item) => String(item.id).replace(/^session-/, '') === key)
  if (!entry) throw fail(404, '回收站里没有这个会话')

  const group = typeof entry.group === 'string' && entry.group !== '' ? entry.group : null
  if (group === null || !isSafeSegment(group)) {
    throw fail(409, '这条删除登记缺少（或含非法）原分组信息，无法自动归位')
  }
  const target = path.join(store.sessionsRoot, group, entry.id)
  // 纵深防御：即使登记文件被改坏，也绝不让还原写到 sessions 目录之外。
  if (!isSafeSegment(entry.id) || !isInside(store.sessionsRoot, target)) {
    throw fail(409, '这条删除登记的目标路径不合法，已拒绝还原')
  }
  const from = path.join(entry.dir, 'session')
  try {
    await fsp.access(target)
    throw fail(409, '目标分组里已经存在同名会话，先处理它再还原')
  } catch (error) {
    if (error?.status === 409) throw error
    /* 目标不存在，正常 */
  }

  await moveTree(from, target)
  const projection = path.join(entry.dir, 'projcache.json')
  const hasProjection = await fsp
    .access(projection)
    .then(() => true)
    .catch(() => false)
  if (hasProjection) await moveTree(projection, store.projectionPath(entry.id))
  await removeTree(entry.dir)
  await store.dropTrash(entry.id)

  const registry = optional(service, 'workspaceRegistry')
  if (registry && typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(entry.id).catch(() => {})
  }
  return { ok: true, id: entry.id, restoredTo: target }
}

/**
 * 彻底删除回收站条目：不可恢复。
 *
 * 三步都要做，缺一步侧栏就会留痕（顺序也是有讲究的）：
 *   1. 删文件（回收站目录 + 登记）；
 *   2. 从工作区账本与归档集合里摘掉这个 id；
 *   3. 如果它在宿主会话表里还活着，把它从表里摘掉——这一步是「重启才消失」的那个残留的解药。
 * 之后浏览器半身会调 `sessions.refresh()` 重新拉一次清单。
 */
async function purgeSession({ store, service, id, logger, waterfall }) {
  const entries = await store.trashEntries()
  const key = String(id).replace(/^session-/, '')
  const entry = entries.find((item) => String(item.id).replace(/^session-/, '') === key)
  if (!entry) throw fail(404, '回收站里没有这个会话')
  await removeTree(entry.dir)
  await store.dropTrash(entry.id)
  const cleanup = await detachEverywhere({ service, id: entry.id })
  const live = await forgetLiveSession({ service, id: entry.id, logger, waterfall })
  return { ok: true, id: entry.id, purged: true, ...cleanup, ...live }
}

/** 插件入口。 */
export function apply(ctx, config = {}) {
  const home = typeof config.home === 'string' && config.home !== '' ? path.resolve(config.home) : resolveHome()
  const store = new SessionStore(home)
  const logger = ctx?.logger
  const service = (serviceName) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    } catch {
      return undefined
    }
  }

  // 回收站目录尽早建好，但建不出来也不能让插件激活失败——真正用到时还会再建一次。
  try {
    fs.mkdirSync(store.trashRoot, { recursive: true })
  } catch (error) {
    logger?.warn?.(`dsh-session-trash: 无法创建回收站目录 ${store.trashRoot}: ${error?.message ?? error}`)
  }

  // 与官方归档同源的「这个会话还在活动吗」判据，用于给摘活会话加安全阀。
  const waterfall =
    typeof ctx?.waterfall === 'function' ? (event, payload, fallback) => ctx.waterfall(event, payload, fallback) : undefined

  const handler = createHandler({ store, service, logger, waterfall })

  // webServer 由浏览器组合晚于本插件发布，用 ctx.inject 等它就位（并在被替换后重挂）。
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    if (!server || typeof server.register !== 'function') return
    scoped.effect(
      () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-session-trash: routes',
    )
    logger?.info?.(`dsh-session-trash: 会话回收站路由已挂载 ${ROUTE_PREFIX}（DSH_HOME=${home}）`)
  })
}

/** 供测试使用的内部句柄。 */
export const __internal = { SessionStore, createHandler, buildListing, deleteSession, restoreSession, purgeSession, detachEverywhere, forgetLiveSession, ROUTE_PREFIX, SESSION_LOG }
