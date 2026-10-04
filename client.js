/**
 * dsh-session-trash — browser half.
 *
 * 往 Web/桌面端的设置里加一个「会话回收站」分区：
 *   - 列出全部会话（标题、工作目录、最近活动、占用大小、归档状态）
 *   - 删除 = 官方归档（移出侧栏）+ 日志目录与投影缓存进回收站，可还原
 *   - 回收站：还原回原分组，或彻底删除 / 清空
 *   - 幽灵会话（工作区有登记、磁盘没有日志目录）可以只清理登记
 *
 * 手写 ModuleLoader bundle：没有构建步骤，除外壳本来就提供的 `react` 之外没有依赖。
 * 数据一律走插件自己的同源 `/api/dsh-session-trash/*` 路由，因此不依赖任何客户端
 * 会话 store 的内部结构——内核插槽或 store 换代都不会让这页失效。
 * 颜色只用中性色与 currentColor，浅色/深色主题都不需要额外适配。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dshSessionTrash'
    const API = '/api/dsh-session-trash'
    const inject = ['slots', 'locale']

    // ── 文案 ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '会话回收站',
        title: '会话回收站',
        subtitle: '删除会话，而不是只把它归档隐藏。删除先进回收站，可以还原；确认不要了再彻底删除。',
        refresh: '刷新',
        loading: '正在读取会话列表…',
        loadFailed: '读取失败',
        retry: '重试',
        search: '按标题、会话 ID 或工作目录筛选',
        empty: '没有任何会话。',
        emptyFiltered: '没有匹配的会话。',
        sectionSessions: '全部会话',
        sectionTrash: '回收站',
        groupOthers: '未分组',
        trashEmpty: '回收站是空的。',
        emptyAll: '清空回收站',
        count: '共 {n} 个',
        blank: '空白会话',
        noTitle: '(无标题)',
        badgeArchived: '已归档',
        del: '删除',
        restore: '还原',
        purge: '彻底删除',
        working: '处理中…',
        dialogConfirm: '确认',
        dialogCancel: '取消',
        confirmDelete: '删除会话「{title}」？\n\n它会先被归档并从侧栏移出，日志目录与投影缓存一起移入回收站（$DSH_HOME/session-trash），之后可以还原。',
        confirmRestore: '把会话「{title}」从回收站还原？\n\n文件会归位到原工作区分组，并自动解除归档，立即回到侧栏。',
        confirmPurge: '彻底删除会话「{title}」？\n\n这会删除回收站里的日志目录，并把这个 id 从工作区记账与归档集合里一并摘掉（否则侧栏会留下「未分组」里的幽灵行）。不可恢复。',
        confirmEmpty: '清空回收站？\n\n里面所有会话的日志目录都会被永久删除，并从工作区记账与归档集合里摘掉。不可恢复。',
        hintHome: 'DSH_HOME',
        noteDeleted: '已移入回收站：{id}',
        noteRestored: '已还原：{id}',
        notePurged: '已彻底删除并清理记账：{id}',
        noteStale: '宿主里这些会话已经摘掉了，但本页拿到的仍是刷新前的缓存数据。刷新一次界面即可同步；若刷新后它们还在，请告诉我。',
        reloadNow: '刷新界面',
        noteEmptied: '回收站已清空（{n} 项）',
        warnNoBackend: '没有连上插件后端——请确认插件已安装到当前 profile 并重启了 DSH。',
      },
      en: {
        nav: 'Session trash',
        title: 'Session trash',
        subtitle: 'Actually delete sessions instead of only archiving them. Deletions land in a trash folder first; purge when you are sure.',
        refresh: 'Refresh',
        loading: 'Loading sessions…',
        loadFailed: 'Load failed',
        retry: 'Retry',
        search: 'Filter by title, session id or working directory',
        empty: 'No sessions.',
        emptyFiltered: 'No matching sessions.',
        sectionSessions: 'All sessions',
        sectionTrash: 'Trash',
        groupOthers: 'Ungrouped',
        trashEmpty: 'Trash is empty.',
        emptyAll: 'Empty trash',
        count: '{n} total',
        blank: 'blank session',
        noTitle: '(untitled)',
        badgeArchived: 'archived',
        del: 'Delete',
        restore: 'Restore',
        purge: 'Delete permanently',
        working: 'Working…',
        dialogConfirm: 'Confirm',
        dialogCancel: 'Cancel',
        confirmDelete: 'Delete session "{title}"?\n\nIt is archived and removed from the sidebar, and its log directory plus projection cache move to the trash ($DSH_HOME/session-trash). You can restore it later.',
        confirmRestore: 'Restore session "{title}" from the trash?\n\nFiles return to their original workspace group and the session is unarchived.',
        confirmPurge: 'Permanently delete session "{title}"?\n\nThis removes the log directory from the trash and drops the id from workspace accounting and the archive set — otherwise a phantom row stays under "Ungrouped". It cannot be undone.',
        confirmEmpty: 'Empty the trash?\n\nEvery session log directory in it is permanently removed and dropped from workspace accounting and the archive set. This cannot be undone.',
        hintHome: 'DSH_HOME',
        noteDeleted: 'Moved to trash: {id}',
        noteRestored: 'Restored: {id}',
        notePurged: 'Permanently deleted, accounting cleaned: {id}',
        noteStale: 'The host has already dropped these sessions, but this page is still showing pre-refresh cached data. Reload the page once to sync; tell me if they survive the reload.',
        reloadNow: 'Reload the page',
        noteEmptied: 'Trash emptied ({n} items)',
        warnNoBackend: 'The plugin backend is unreachable — make sure it is installed into the current profile and DSH was restarted.',
      },
    }

    // ── 同源 API ─────────────────────────────────────────────────────────────
    async function api(pathname, body) {
      const response = await fetch(`${API}${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text }
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    // ── 格式化 ───────────────────────────────────────────────────────────────
    function formatTime(ms, locale) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      try {
        return new Date(ms).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return new Date(ms).toISOString()
      }
    }

    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** 取标题：没有标题就按空白/无标题显示，绝不留空。 */
    function displayTitle(row, t) {
      if (typeof row.title === 'string' && row.title.trim() !== '') return row.title
      return row.blank ? t('blank') : t('noTitle')
    }

    // ── 样式 ─────────────────────────────────────────────────────────────────
    const MUTED = 'rgba(127,127,127,0.9)'
    const HAIRLINE = '1px solid rgba(127,127,127,0.25)'
    const SOFT = 'rgba(127,127,127,0.08)'

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px 28px', color: 'inherit', fontSize: '13px' },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      h1: { margin: 0, fontSize: '18px', fontWeight: 600 },
      sub: { margin: '4px 0 0', color: MUTED, lineHeight: 1.6, maxWidth: '62ch' },
      home: { color: MUTED, fontSize: '11.5px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
      bar: { display: 'flex', gap: '8px', alignItems: 'center' },
      input: {
        flex: '1 1 auto',
        minWidth: 0,
        padding: '6px 9px',
        borderRadius: '6px',
        border: HAIRLINE,
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px',
      },
      button: {
        padding: '5px 10px',
        borderRadius: '6px',
        border: HAIRLINE,
        background: SOFT,
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonDanger: {
        padding: '5px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(214,72,72,0.5)',
        background: 'rgba(214,72,72,0.12)',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      section: { display: 'flex', flexDirection: 'column', gap: '10px' },
      sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
      h2: { margin: 0, fontSize: '14px', fontWeight: 600 },
      sectionMeta: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 },
      groups: { display: 'flex', flexDirection: 'column', gap: '12px' },
      group: { display: 'flex', flexDirection: 'column', gap: '5px' },
      groupHead: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0, padding: '0 2px' },
      groupPath: {
        flex: '1 1 auto',
        minWidth: 0,
        color: MUTED,
        fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      groupCount: { flex: 'none', color: MUTED, fontSize: '11.5px' },
      list: { display: 'flex', flexDirection: 'column', border: HAIRLINE, borderRadius: '8px', overflow: 'hidden' },
      // 每行是一个两列 grid：左列吃满剩余宽度（长标题/长 id 一律省略号），右列是固定宽度的
      // 操作区。两列在所有行里对齐——上一版用 flex + wrap，徽章和按钮互相挤，行高不齐、
      // 按钮还会被卡片裁掉，就是「错位」的来源。
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        columnGap: '12px',
        alignItems: 'center',
        padding: '9px 12px',
        borderTop: HAIRLINE,
      },
      rowFirst: { borderTop: 'none' },
      cell: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
      rowTitle: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { display: 'flex', alignItems: 'center', gap: '6px', color: MUTED, fontSize: '11.5px', minWidth: 0 },
      metaFixed: { flex: 'none' },
      metaId: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      badges: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' },
      hint: { color: MUTED, fontSize: '11px', marginTop: '2px' },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: HAIRLINE,
        background: SOFT,
        color: MUTED,
        whiteSpace: 'nowrap',
      },
      rowActions: { display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0, whiteSpace: 'nowrap' },
      note: { padding: '7px 10px', borderRadius: '6px', border: HAIRLINE, background: SOFT },
      warn: { padding: '7px 10px', borderRadius: '6px', border: '1px solid rgba(214,160,72,0.5)', background: 'rgba(214,160,72,0.12)' },
      error: { padding: '7px 10px', borderRadius: '6px', border: '1px solid rgba(214,72,72,0.45)', background: 'rgba(214,72,72,0.1)' },
      empty: { color: MUTED, padding: '10px 2px' },
      // 页面内确认框：颜色全部走 DSH 自己的主题变量（读不到才用中性兜底）。
      // 这里刻意**不用**写死的暗色蒙层：那会让浅色主题下弹出确认框时整个界面像切进了深色模式。
      // `--dsw-alias-bg-mask-1` 是外壳自己弹模态用的蒙层色，跟随系统/用户主题；
      // `--dsw-alias-bg-layer-2` 是模态面板的底色，卡片直接复用同一个。
      overlay: { position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      dialogMask: {
        position: 'absolute',
        inset: 0,
        background: 'var(--dsw-alias-bg-mask-1, rgba(127,127,127,0.28))',
        backdropFilter: 'var(--dsw-mask-blur, blur(2px))',
      },
      dialog: {
        position: 'relative',
        width: 'min(460px, calc(100vw - 48px))',
        padding: '16px 18px',
        borderRadius: 'var(--dsw-radius-panel, 10px)',
        border: HAIRLINE,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,0.3))',
        fontSize: '13px',
        lineHeight: 1.6,
      },
      dialogBody: { whiteSpace: 'pre-line' },
      dialogActions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' },
    }

    /**
     * 按工作区分组。路径取宿主给的 `workspacePath`（工作区账本里的路径；回收站条目用它
     * 删除时记下的 cwd），取不到就回落到 cwd，再取不到就归到「未分组」，未分组永远排最后。
     *
     * 放在模块作用域而不是组件里，一是它不依赖任何组件状态，二是可以直接测。
     */
    function groupByWorkspace(rows) {
      const groups = new Map()
      for (const row of rows) {
        const path =
          typeof row.workspacePath === 'string' && row.workspacePath !== ''
            ? row.workspacePath
            : typeof row.cwd === 'string' && row.cwd !== ''
              ? row.cwd
              : ''
        if (!groups.has(path)) groups.set(path, [])
        groups.get(path).push(row)
      }
      return [...groups.entries()]
        .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
        .map(([path, items]) => ({ path, items }))
    }

    // ── 页面 ─────────────────────────────────────────────────────────────────
    function SessionTrashPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      // 外壳的两个能力，由 apply() 注入：刷新会话清单、探询某个会话在宿主里是否还活着。
      const refreshShell = typeof props?.refreshShell === 'function' ? props.refreshShell : null
      const sessionStillKnown = typeof props?.sessionStillKnown === 'function' ? props.sessionStillKnown : null
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      // 待确认的破坏性动作；null 表示没有对话框。
      const [pending, setPending] = useState(null)
      // 彻底删除后仍被宿主会话表报出来的 id：这类会话还「活着」，需要刷新界面才会彻底消失。
      const [staleIds, setStaleIds] = useState([])
      const cancelRef = useRef(null)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const payload = await api('/list')
          setData(payload)
          setError(null)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      /**
       * 执行一个已确认的动作：调接口 → 让外壳重新拉一次会话清单 → 刷新本页 → 报结果。
       *
       * 注意这里**不弹原生对话框**。DSH 客户端自己一个 window.confirm/alert/prompt
       * 都不用（整个 asar 里 0 处），不是审美偏好：Electron 里从渲染进程弹原生模态框，
       * 关闭后窗口可能拿不回键盘焦点——表现为点得动、打不了字，最小化到托盘再恢复才恢复。
       * 所以确认一律用页面内自绘的对话框。
       */
      const run = useCallback(
        async (action) => {
          setBusy(action.key)
          setNote('')
          // 这次动作之后本应消失的 id：彻底删除可能涉及一个（/purge）或一批（/empty）。
          const tracked =
            action.path === '/purge' && typeof action.payload?.id === 'string'
              ? [action.payload.id]
              : action.path === '/empty'
                ? (Array.isArray(data?.trash) ? data.trash.map((row) => row.id) : [])
                : []
          try {
            const result = await api(action.path, action.payload)
            // 关键一步：让外壳重新拉一次会话清单。宿主侧刚把会话从账本与归档集合里摘掉，
            // 但浏览器投影里还缓存着那条已经没有数据的行——不重新拉，它就会一直挂在侧栏
            // （「未分组」下，或者原工作区里显示成「已归档」的样子）直到下次刷新。
            if (refreshShell !== null) refreshShell()
            await load()
            // 拉完还在？那说明这个会话在宿主里仍然「活着」（客户端还持有它：最近打开、
            // 正在跑或还挂在某个视图上）。这种状态下任何额度清理都拦不住它被列出来，
            // 只能让整页重新取一次数据——顺便让旧连接上的会话句柄被释放。
            setStaleIds(
              tracked.length > 0 && sessionStillKnown !== null ? tracked.filter((id) => sessionStillKnown(id)) : [],
            )
            if (action.noteKey) {
              setNote(
                t(action.noteKey)
                  .replace('{id}', String(result?.id ?? action.payload?.id ?? ''))
                  .replace('{n}', String(result?.removed ?? '')),
              )
            }
          } catch (cause) {
            setNote('')
            setError(cause?.message ?? String(cause))
          } finally {
            setBusy('')
          }
        },
        [data, load, refreshShell, sessionStillKnown, t],
      )

      /** 打开确认对话框（破坏性动作走这里）。 */
      const ask = useCallback((action) => setPending(action), [])
      const dismiss = useCallback(() => setPending(null), [])
      const accept = useCallback(() => {
        const action = pending
        setPending(null)
        if (action) void run(action)
      }, [pending, run])

      // 对话框打开期间接管 Escape，并阻止它继续冒泡去关掉整个设置面板。
      useEffect(() => {
        if (pending === null || typeof document === 'undefined') return undefined
        const onKey = (event) => {
          if (event?.key !== 'Escape') return
          event.stopPropagation?.()
          dismiss()
        }
        document.addEventListener('keydown', onKey, true)
        // 焦点先给「取消」：Enter 落在取消上，避免误删。
        cancelRef.current?.focus?.()
        return () => document.removeEventListener('keydown', onKey, true)
      }, [pending, dismiss])

      const sessions = Array.isArray(data?.sessions) ? data.sessions : []
      const trash = Array.isArray(data?.trash) ? data.trash : []

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return sessions
        return sessions.filter((row) => {
          const haystack = [row.title, row.id, row.cwd].filter((value) => typeof value === 'string').join(' ').toLowerCase()
          return haystack.includes(needle)
        })
      }, [sessions, query])

      const locale = typeof props?.locale === 'string' ? props.locale : 'en'

      function rowFor(row, isTrash, first) {
        const key = `${isTrash ? 'trash' : 'live'}:${row.id}`
        // 账本/归档里记着、磁盘上却没有日志：DSH 自己留下的残留。本插件**不再**去改它
        // 这里只会出现磁盘上真的有日志的会话（宿主已经把没有日志的账本残留过滤掉了），
        // 因此每行都有可执行的操作，不存在「只标注、没按钮」的行。
        const badges = []
        if (!isTrash && row.archived === true) badges.push(t('badgeArchived'))

        return h(
          'div',
          { key, style: first ? { ...S.row, borderTop: 'none' } : S.row },
          h(
            'div',
            { style: S.cell },
            h('div', { style: S.rowTitle, title: displayTitle(row, t) }, displayTitle(row, t)),
            h(
              'div',
              { style: S.meta },
              h('span', { style: S.metaFixed }, formatTime(isTrash ? row.deletedAt : row.updatedAt, locale)),
              h('span', { style: S.metaFixed }, '·'),
              h('span', { style: S.metaFixed }, formatSize(row.sizeBytes)),
              h('span', { style: S.metaFixed }, '·'),
              h('span', { style: S.metaId, title: String(row.id) }, String(row.id)),
            ),
            badges.length > 0 ? h('div', { style: S.badges }, badges.map((text) => h('span', { key: text, style: S.badge }, text))) : null,
          ),
          h(
            'div',
            { style: S.rowActions },
            ...(isTrash
              ? [
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.button,
                      disabled: busy !== '',
                      onClick: () => run({ key, path: '/restore', payload: { id: row.id }, noteKey: 'noteRestored' }),
                    },
                    busy === key ? t('working') : t('restore'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.buttonDanger,
                      disabled: busy !== '',
                      onClick: () =>
                        ask({
                          key,
                          path: '/purge',
                          payload: { id: row.id },
                          noteKey: 'notePurged',
                          danger: true,
                          message: t('confirmPurge').replace('{title}', displayTitle(row, t)),
                        }),
                    },
                    t('purge'),
                  ),
                ]
              : [
                  row.onDisk === true
                    ? h(
                        'button',
                        {
                          type: 'button',
                          style: S.buttonDanger,
                          disabled: busy !== '',
                          onClick: () =>
                            ask({
                              key,
                              path: '/delete',
                              payload: { id: row.id },
                              noteKey: 'noteDeleted',
                              danger: true,
                              message: t('confirmDelete').replace('{title}', displayTitle(row, t)),
                            }),
                        },
                        busy === key ? t('working') : t('del'),
                      )
                    : null,
                ]),
          ),
        )
      }

      /** 一个分区：标题 + 计数（+ 可选的整体操作），下面是按工作区分组的卡片。 */
      function sectionFor(title, rows, isTrash, emptyText) {
        return h(
          'section',
          { style: S.section },
          h(
            'div',
            { style: S.sectionHead },
            h('h2', { style: S.h2 }, title),
            h(
              'div',
              { style: S.sectionMeta },
              h('span', { style: S.badge }, t('count').replace('{n}', String(rows.length))),
              isTrash && rows.length > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.buttonDanger,
                      disabled: busy !== '',
                      onClick: () => ask({ key: 'empty', path: '/empty', payload: {}, noteKey: 'noteEmptied', danger: true, message: t('confirmEmpty') }),
                    },
                    t('emptyAll'),
                  )
                : null,
            ),
          ),
          rows.length === 0
            ? h('div', { style: S.empty }, emptyText)
            : h(
                'div',
                { style: S.groups },
                groupByWorkspace(rows).map((group) =>
                  h(
                    'div',
                    { key: group.path === '' ? '__ungrouped__' : group.path, style: S.group },
                    h(
                      'div',
                      { style: S.groupHead },
                      h('span', { style: S.groupPath, title: group.path === '' ? t('groupOthers') : group.path }, group.path === '' ? t('groupOthers') : group.path),
                      h('span', { style: S.groupCount }, String(group.items.length)),
                    ),
                    h('div', { style: S.list }, group.items.map((row, index) => rowFor(row, isTrash, index === 0))),
                  ),
                ),
              ),
        )
      }

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.head },
          h('div', { style: { minWidth: 0 } }, h('h1', { style: S.h1 }, t('title')), h('p', { style: S.sub }, t('subtitle'))),
          h('button', { type: 'button', style: S.button, disabled: loading, onClick: () => void load() }, t('refresh')),
        ),
        data?.home ? h('div', { style: S.home }, `${t('hintHome')}: ${data.home}`) : null,

        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            type: 'search',
            value: query,
            placeholder: t('search'),
            onChange: (event) => setQuery(event.target.value),
          }),
        ),

        note !== '' ? h('div', { style: S.note }, note) : null,
        staleIds.length > 0
          ? h(
              'div',
              { style: S.warn },
              h('div', null, t('noteStale')),
              h(
                'div',
                { style: { marginTop: '6px' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.button,
                    onClick: () => {
                      try {
                        window.location.reload()
                      } catch {
                        /* 顶层导航被拒绝时忽略 */
                      }
                    },
                  },
                  t('reloadNow'),
                ),
              ),
            )
          : null,
        error !== null
          ? h(
              'div',
              { style: S.error },
              h('div', null, `${t('loadFailed')}：${error}`),
              h('div', { style: { marginTop: '6px' } }, h('button', { type: 'button', style: S.button, onClick: () => void load() }, t('retry'))),
            )
          : null,

        loading && data === null ? h('div', { style: S.sub }, t('loading')) : null,

        data !== null
          ? sectionFor(t('sectionSessions'), filtered, false, sessions.length === 0 ? t('empty') : t('emptyFiltered'))
          : null,

        data !== null ? sectionFor(t('sectionTrash'), trash, true, t('trashEmpty')) : null,

        data === null && error === null && !loading ? h('div', { style: S.sub }, t('warnNoBackend')) : null,

        // 页面内确认框：不用原生 confirm（见 run() 的注释）。
        pending !== null
          ? h(
              'div',
              { style: S.overlay, role: 'presentation' },
              h('div', { style: S.dialogMask, 'aria-hidden': 'true', onClick: dismiss }),
              h(
                'div',
                { style: S.dialog, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
                h('div', { style: S.dialogBody }, pending.message),
                h(
                  'div',
                  { style: S.dialogActions },
                  h(
                    'button',
                    { type: 'button', ref: cancelRef, style: S.button, onClick: dismiss, 'data-dsh-trash-dialog': 'cancel' },
                    t('dialogCancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: pending.danger === true ? S.buttonDanger : S.button,
                      onClick: accept,
                      'data-dsh-trash-dialog': 'confirm',
                    },
                    t('dialogConfirm'),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    // ── 导航图标 ─────────────────────────────────────────────────────────────
    // 设置外壳把导航图标写死成「按 section id 查表」：account/models/agent-presets/
    // plugins/archived-sessions 各有自己的字形，**其余 id 一律回落到齿轮**——而
    // 「通用设置」(id: general) 用的正是那个齿轮，所以第三方分区默认会和它撞在一起。
    // settings.section 的注册项只携带 id/order/label，没有图标字段；因此正确的做法不是
    // 去借一个别人的 id（会和官方分区撞 id），而是给**自己这一行**换掉字形：
    // 打上标记 → 隐藏外壳塞进来的 svg → 用 mask 画一个跟着文字色的垃圾桶。
    const NAV_ATTR = 'data-dsh-session-trash-nav'

    /**
     * 垃圾桶字形；作为 mask 使用，因此只取它的不透明度，颜色跟着按钮的 currentColor 走。
     * 描边用白色（而不是黑色）是为了在 alpha 与 luminance 两种 mask 解释下都不透明。
     */
    const TRASH_GLYPH = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 7h16"/>' +
        '<path d="M10 11v6"/><path d="M14 11v6"/>' +
        '<path d="M5.6 7l.9 12.1A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.9L18.4 7"/>' +
        '<path d="M9.5 7V5.3A1.3 1.3 0 0 1 10.8 4h2.4a1.3 1.3 0 0 1 1.3 1.3V7"/>' +
        '</svg>',
    )

    const NAV_ICON_CSS = [
      `button[${NAV_ATTR}] > svg { display: none !important; }`,
      `button[${NAV_ATTR}]::before {`,
      '  content: "";',
      '  flex: none;',
      '  width: 16px;',
      '  height: 16px;',
      '  background-color: currentColor;',
      `  -webkit-mask: url("data:image/svg+xml;charset=utf-8,${TRASH_GLYPH}") center / 16px 16px no-repeat;`,
      `  mask: url("data:image/svg+xml;charset=utf-8,${TRASH_GLYPH}") center / 16px 16px no-repeat;`,
      '}',
    ].join('\n')

    /**
     * 给「文案等于本插件导航名」的导航按钮打标记。
     *
     * 只认同时具备 svg 图标与匹配文案的按钮：侧栏底部那个「设置」触发按钮也是
     * svg + 文字的结构，但文案不匹配，因此不会被误伤。幂等，可反复调用。
     *
     * @param root - 查询范围（浏览器里就是 document）。
     * @param labels - 可能的导航文案（中/英）。
     * @returns 本次新标记的按钮数量。
     */
    function tagNavButtons(root, labels) {
      if (!root || typeof root.querySelectorAll !== 'function') return 0
      let tagged = 0
      for (const button of root.querySelectorAll('button')) {
        if (button.getAttribute(NAV_ATTR) === '1') continue
        let hasIcon = false
        let label = ''
        for (const child of button.children ?? []) {
          const tag = String(child.tagName ?? '').toLowerCase()
          if (tag === 'svg') hasIcon = true
          else if (tag === 'span') label = child.textContent ?? ''
        }
        if (!hasIcon || !labels.includes(label.trim())) continue
        button.setAttribute(NAV_ATTR, '1')
        tagged++
      }
      return tagged
    }

    // ── 注册 ─────────────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-session-trash: dictionaries')

      /**
       * 让外壳重新拉一次会话清单。
       *
       * 客户端会话控制器是注册成 `sessions` 服务的，并且对外暴露了 `refresh()`
       * （内部走 `session.list` 全量拉取、单飞复用）。宿主侧摘掉账本/归档标记之后必须调它：
       * 否则浏览器会继续用缓存里那条没有数据的行重画侧栏，表现为「未分组」下多一行、
       * 或在工作区里显示成「已归档」的样子，直到用户手动刷新。
       * 拿不到这个服务也不要紧——宿主那份状态已经是对的，下次刷新自然会一致。
       */
      const refreshShell = () => {
        try {
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.refresh === 'function') void sessions.refresh()
        } catch {
          /* 服务不可用就跳过，不影响删除本身 */
        }
      }

      /**
       * 这个会话在外壳的会话清单里还在不在？
       *
       * 在 = 宿主仍然认为它「活着」（客户端还持有它：最近打开、正在跑，或挂在某个视图上）。
       * 这种会话即使账本、归档集合都摘干净了，宿主照样会把它列出来，于是它落在「未分组」下；
       * 只有让整页重新取一次数据（旧连接上的句柄随之释放）才会彻底消失。
       * 读的是客户端会话控制器公开的 `list` 快照，任何一步拿不到都按「不在」处理。
       */
      const sessionStillKnown = (id) => {
        try {
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          const snapshot = sessions?.list?.getSnapshot?.()
          if (snapshot === undefined || snapshot === null) return false
          if (snapshot.byId !== undefined && snapshot.byId[id] !== undefined) return true
          return Array.isArray(snapshot.ids) && snapshot.ids.includes(id)
        } catch {
          return false
        }
      }

      // 图标补丁与插件同生共死：设置面板不在 DOM 里时它什么都不做。
      ctx.effect(() => {
        if (typeof document === 'undefined' || !document.head) return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-session-trash')
        style.textContent = NAV_ICON_CSS
        document.head.appendChild(style)

        const labels = [DICT.zh.nav, DICT.en.nav]
        const patch = () => {
          try {
            tagNavButtons(document, labels)
          } catch {
            /* 外壳换了结构就维持齿轮图标，功能不受影响 */
          }
        }
        patch()

        // 只观察 body 的直接子节点：设置面板是 createPortal(..., document.body)，
        // 开合各产生一次 childList 变更。故意不开 subtree/characterData —— 那会让
        // 流式输出期间的每一次 DOM 变更都触发一次全文档扫描。
        // 语言切换不需要重新打标记：按钮节点被 React 复用时属性仍在。
        const timers = []
        let queued = 0
        const schedule = () => {
          if (queued !== 0) return
          queued = setTimeout(() => {
            queued = 0
            patch()
          }, 50)
        }
        let observer = null
        if (typeof MutationObserver === 'function' && document.body) {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true })
        }
        // 兜底：面板挂载时序与 React 分批提交不一致时，开场补扫三次。
        for (const delay of [120, 400, 1000]) timers.push(setTimeout(patch, delay))

        return () => {
          observer?.disconnect()
          if (queued !== 0) clearTimeout(queued)
          for (const timer of timers) clearTimeout(timer)
          style.remove()
        }
      }, 'dsh-session-trash: nav icon')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-session-trash',
            order: 36,
            label: () => t('nav'),
            locale: NS,
          },
          (props) => h(SessionTrashPage, { ...props, t, refreshShell, sessionStillKnown }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-session-trash'
    exports.__test = { SessionTrashPage, displayTitle, formatSize, api, groupByWorkspace, tagNavButtons, NAV_ICON_CSS, NAV_ATTR }
    return module.exports
  },
})
