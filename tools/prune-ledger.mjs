#!/usr/bin/env node
/**
 * prune-ledger.mjs — 离线清理 DSH 工作区记账里的残留 id。
 *
 * 为什么必须离线：`storages/workspace.json` 在运行期由 workspaceRegistry 的内存状态持有，
 * 每次写入都会整份重写，进程外改文件会被覆盖；而在运行期通过服务改记账，又会广播变更、
 * 让浏览器投影缓存里那些「没有数据的行」在侧栏「未分组」下显形。DSH 自己的启动对账也
 * **不会**删这些 id（bootstrap 明确保留账本里没有 header 的 id，只打一条 warn 日志：
 * "filtered session ... from membership: session header is missing"）。
 *
 * 所以正确做法是：停掉 DSH → 跑这个脚本 → 启动 DSH。默认只做 dry-run。
 *
 * 清理两种残留：
 *   1) 工作区 record.sessionIds 里，磁盘上已经没有日志目录的 id；
 *   2) archivedSessionIds 里，磁盘上已经没有日志目录的 id（含账本里也没有的）。
 *
 * 用法：
 *   node tools/prune-ledger.mjs              # 只看会删什么（默认，不动文件）
 *   node tools/prune-ledger.mjs --apply      # 真的写（先自动备份 workspace.json）
 *
 * 需要 DSH 完全退出。脚本会检查 workspace.json 是否可独占写入，占用时直接拒绝。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
const WORKSPACE_FILE = path.join(HOME, 'storages', 'workspace.json')
const SESSIONS_ROOT = path.join(HOME, 'sessions')

const log = (...args) => console.log(...args)

if (!fs.existsSync(WORKSPACE_FILE)) {
  console.error(`找不到 ${WORKSPACE_FILE}`)
  process.exit(1)
}

/** 磁盘上真实存在的会话 id（带 session- 前缀，与记账里的写法一致）。 */
function idsOnDisk() {
  const ids = new Set()
  if (!fs.existsSync(SESSIONS_ROOT)) return ids
  for (const group of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    let entries = []
    try {
      entries = fs.readdirSync(path.join(SESSIONS_ROOT, group.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) ids.add(entry.name)
  }
  return ids
}

const sameId = (a, b) => String(a).replace(/^session-/, '') === String(b).replace(/^session-/, '')

// 只有真要写的时候才需要独占：DSH 运行时会持有这份文件（但注意，读权限不足或沙箱策略
// 也会给出同样的 EPERM，所以这里只作为提示，不作为「DSH 一定在跑」的证据）。
if (APPLY) {
  try {
    const handle = fs.openSync(WORKSPACE_FILE, 'r+')
    fs.closeSync(handle)
  } catch (error) {
    console.error(
      `无法以可写方式打开 ${WORKSPACE_FILE}（${error.code ?? error.message}）。\n` +
        '请先完全退出 DSH 再运行；如果 DSH 确实已经退出，检查一下这个文件是否被其它程序占用、以及当前账户有没有写权限。',
    )
    process.exit(1)
  }
}

const raw = fs.readFileSync(WORKSPACE_FILE, 'utf8')
let ledger
try {
  // 容忍 BOM：DSH 自己不写 BOM，但用某些编辑器改过之后会带上，JSON.parse 会直接拒绝。
  ledger = JSON.parse(raw.replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`workspace.json 解析失败：${error.message}`)
  process.exit(1)
}

// 账本结构不对就停手：下面的「残留」判定完全建立在能读到 tables.workspaces 之上，
// 结构意外时宁可什么都不做，也不要按错误的形状去改一份正在用的账本。
if (ledger === null || typeof ledger !== 'object' || ledger.tables === null || typeof ledger.tables !== 'object') {
  console.error(`${WORKSPACE_FILE} 里没有预期的 tables 结构（可能是别的版本或已被改写）。为避免误删，已停止。`)
  process.exit(1)
}

const onDisk = idsOnDisk()

// 关键安全阀：磁盘上一个会话目录都没有时，「所有账本 id 都是残留」这个推论几乎肯定是错的
// （DSH_HOME 指错、sessions 被移动/改名、或权限读不到）。这种情况下拒绝运行。
if (onDisk.size === 0 && !process.argv.includes('--force')) {
  console.error(
    `在 ${SESSIONS_ROOT} 下一个会话目录都没找到。\n` +
      '如果就这样继续，账本里**每一个** id 都会被判定为残留并被移除——这几乎一定是 DSH_HOME 指错、\n' +
      '目录被移动过、或当前账户读不到它，而不是真的全都删光了。\n' +
      '请先确认路径；确实要在这个状态下继续，加 --force 明确承担。',
  )
  process.exit(1)
}

log(`DSH_HOME        : ${HOME}`)
log(`磁盘上的会话    : ${onDisk.size} 个`)
log(`模式            : ${APPLY ? 'APPLY（会写入）' : 'dry-run（不动文件）'}`)

const drop = []
const workspaces = ledger.tables?.workspaces ?? {}
for (const [workspaceId, record] of Object.entries(workspaces)) {
  const ids = Array.isArray(record.sessionIds) ? record.sessionIds : []
  const keep = ids.filter((id) => [...onDisk].some((name) => sameId(name, id)))
  const removed = ids.filter((id) => !keep.includes(id))
  for (const id of removed) drop.push({ where: `workspace ${record.path}`, id: String(id) })
  if (APPLY && removed.length > 0) record.sessionIds = keep
}

const archived = Array.isArray(ledger.global?.archivedSessionIds) ? ledger.global.archivedSessionIds : []
const archivedKeep = archived.filter((id) => [...onDisk].some((name) => sameId(name, id)))
const archivedDrop = archived.filter((id) => !archivedKeep.includes(id))
for (const id of archivedDrop) drop.push({ where: 'archivedSessionIds', id: String(id) })

log(`\n将要移除的残留（${drop.length} 条）：`)
for (const item of drop) log(`  ${item.id}   ← ${item.where}`)
if (drop.length === 0) log('  （没有残留，记账是干净的）')

if (!APPLY) {
  log('\n这是 dry-run。确认无误后加 --apply 重跑；脚本会先备份 workspace.json。')
  process.exit(0)
}

if (drop.length === 0) {
  log('\n没有需要写入的内容，文件未改动。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${WORKSPACE_FILE}.bak-prune-${stamp}`
fs.copyFileSync(WORKSPACE_FILE, backup)
if (archivedDrop.length > 0) {
  ledger.global = { ...(ledger.global ?? {}), archivedSessionIds: archivedKeep }
}
const temp = `${WORKSPACE_FILE}.tmp-${process.pid}`
fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
fs.renameSync(temp, WORKSPACE_FILE)
log(`\n已写入。备份：${backup}`)
log(`移除了 ${drop.length} 条残留（工作区 ${drop.length - archivedDrop.length} 条，归档集合 ${archivedDrop.length} 条）。`)
log('现在可以重新启动 DSH 了。')
