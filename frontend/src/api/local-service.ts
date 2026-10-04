import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, DraftRow, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 航空器牵引的业务常量：检索、台账对账、流转回写都用这一份，页面与导出不许各搞一套。
const TOW_KEY = 'tow'
const STAND_KEY = 'stand'
const TOW_STATUSES = ['待牵引', '牵引中', '待确认', '已完成'] as const
const TOW_FIELDS = {
  code: '任务编号',
  flight: '航班号',
  tractor: '牵引车号',
  from: '起始机位',
  to: '目标机位',
  driver: '驾驶员',
  escort: '护送人员',
  escortReady: '护送到位',
  statusText: '任务状态',
} as const

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---- 航空器牵引：按机位定位的派单、流转与台账回写 ----

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10)
}

// 机位台账字段名集中在一处，牵引回写、台账对账都从这里取，避免页面与服务各拼一份。
const MODULE_STAND_FIELDS = {
  code: '机位编号',
  period: '占用时段',
  flight: '当前航班',
  statusText: '机位状态',
} as const

function findStand(standCode: string): EntryRow | undefined {
  const code = standCode.trim()
  return listRows(STAND_KEY).find((row) => String(row[MODULE_STAND_FIELDS.code]).trim() === code)
}

// 机位台账里的机位编号列表：检索下拉、派发校验共用这一份数据。
export function standOptions(): string[] {
  return listRows(STAND_KEY).map((row) => String(row[MODULE_STAND_FIELDS.code]))
}

// 只有台账里状态为「空闲」的机位才能作为牵引目标；占用、维护、封闭一律整条拒绝。
function standAvailable(stand: EntryRow | undefined): boolean {
  return Boolean(stand && String(stand.status) === '空闲')
}

// 同一航班只能有一条有效（未完成）牵引记录，已完成的不再算占用。
function activeTowOfFlight(flight: string, excludeId = -1): EntryRow | undefined {
  const flightCode = flight.trim()
  return listRows(TOW_KEY).find(
    (row) =>
      Number(row.id) !== excludeId &&
      String(row[TOW_FIELDS.flight]).trim() === flightCode &&
      String(row.status) !== '已完成',
  )
}

function nextTowCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const matched = /^TOW-(\d+)$/.exec(String(row[TOW_FIELDS.code] ?? ''))
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `TOW-${String(max + 1).padStart(4, '0')}`
}

// 派发牵引任务：起始/目标机位不能相同，目标机位必须在台账且空闲，同一航班不许重复派发。
// 校验不过时整条拒绝，不产生半截记录。
export function dispatchTow(draft: DraftRow): ActionResult {
  const flight = String(draft[TOW_FIELDS.flight] ?? '').trim()
  const tractor = String(draft[TOW_FIELDS.tractor] ?? '').trim()
  const from = String(draft[TOW_FIELDS.from] ?? '').trim()
  const to = String(draft[TOW_FIELDS.to] ?? '').trim()
  const driver = String(draft[TOW_FIELDS.driver] ?? '').trim()
  const escort = String(draft[TOW_FIELDS.escort] ?? '').trim()

  const missing = [
    !flight && '航班号',
    !tractor && '牵引车号',
    !from && '起始机位',
    !to && '目标机位',
    !driver && '驾驶员',
    !escort && '护送人员',
  ].filter(Boolean)
  if (missing.length) {
    return { ok: false, message: `派发被拒绝：${missing.join('、')}不能为空` }
  }
  if (from === to) {
    return { ok: false, message: `派发被拒绝：起始机位「${from}」与目标机位不能相同` }
  }
  if (!findStand(from)) {
    return { ok: false, message: `派发被拒绝：起始机位「${from}」不在机位台账中` }
  }
  const targetStand = findStand(to)
  if (!targetStand) {
    return { ok: false, message: `派发被拒绝：目标机位「${to}」不在机位台账中` }
  }
  if (!standAvailable(targetStand)) {
    return {
      ok: false,
      message: `派发被拒绝：目标机位「${to}」当前为「${targetStand.status}」，已被占用或不可用`,
    }
  }
  const duplicated = activeTowOfFlight(flight)
  if (duplicated) {
    return {
      ok: false,
      message: `派发被拒绝：航班「${flight}」已存在有效牵引任务「${duplicated[TOW_FIELDS.code]}」（${duplicated.status}），同一航班只保留一条有效记录`,
    }
  }

  const rows = listRows(TOW_KEY)
  const row: EntryRow = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1,
    status: '待牵引',
    pending: true,
    abnormal: false,
    [TOW_FIELDS.code]: nextTowCode(rows),
    [TOW_FIELDS.flight]: flight,
    [TOW_FIELDS.tractor]: tractor,
    [TOW_FIELDS.from]: from,
    [TOW_FIELDS.to]: to,
    [TOW_FIELDS.driver]: driver,
    [TOW_FIELDS.escort]: escort,
    [TOW_FIELDS.escortReady]: '否',
    [TOW_FIELDS.statusText]: '待牵引',
  }
  saveRows(TOW_KEY, [...rows, row])
  return { ok: true, message: `牵引任务「${row[TOW_FIELDS.code]}」已派发，起始机位「${from}」，目标机位「${to}」` }
}

function findTow(id: number): { rows: EntryRow[]; index: number } | ActionResult {
  const rows = listRows(TOW_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的牵引任务` }
  }
  return { rows, index }
}

// 护送人员到位登记：对讲机喊话不再算数，没到位就进不了「牵引中」。
export function markTowEscortReady(id: number): ActionResult {
  const found = findTow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const row = rows[index]
  if (String(row.status) !== '待牵引') {
    return { ok: false, message: `只有「待牵引」任务能登记护送到位，当前状态「${row.status}」` }
  }
  if (String(row[TOW_FIELDS.escortReady]) === '是') {
    return { ok: false, message: '护送人员已经到位，不用重复登记' }
  }
  const next = [...rows]
  next[index] = { ...row, [TOW_FIELDS.escortReady]: '是' }
  saveRows(TOW_KEY, next)
  return { ok: true, message: `任务「${row[TOW_FIELDS.code]}」护送人员「${row[TOW_FIELDS.escort]}」已到位` }
}

// 已完成后再改目标机位一律拒绝；未完成的任务改目标仍要过占用与台账校验。
export function changeTowTarget(id: number, target: string): ActionResult {
  const to = target.trim()
  const found = findTow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const row = rows[index]
  if (String(row.status) === '已完成') {
    return { ok: false, message: `任务「${row[TOW_FIELDS.code]}」已完成，落位结论已回写台账，禁止再改目标机位` }
  }
  if (!to) {
    return { ok: false, message: '目标机位不能为空' }
  }
  if (to === String(row[TOW_FIELDS.from]).trim()) {
    return { ok: false, message: `目标机位不能与起始机位「${row[TOW_FIELDS.from]}」相同` }
  }
  const targetStand = findStand(to)
  if (!targetStand) {
    return { ok: false, message: `目标机位「${to}」不在机位台账中` }
  }
  if (!standAvailable(targetStand)) {
    return { ok: false, message: `目标机位「${to}」当前为「${targetStand.status}」，已被占用或不可用` }
  }
  const next = [...rows]
  next[index] = { ...row, [TOW_FIELDS.to]: to }
  saveRows(TOW_KEY, next)
  return { ok: true, message: `任务「${row[TOW_FIELDS.code]}」目标机位已改为「${to}」` }
}

// 牵引专用流转：只允许待牵引→牵引中→待确认→已完成逐步推进，跳步挡回。
export function runTowAction(id: number, action: string): ActionResult {
  const found = findTow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const row = rows[index]
  const current = String(row.status)
  const step = TOW_STATUSES.indexOf(current as (typeof TOW_STATUSES)[number])
  if (step < 0) {
    return { ok: false, message: `任务当前状态「${current}」不在牵引流转序列中，无法操作` }
  }
  if (step === TOW_STATUSES.length - 1) {
    return { ok: false, message: `任务「${row[TOW_FIELDS.code]}」已完成，终态不可再操作` }
  }
  const target = TOW_STATUSES[step + 1]
  const expectedAction = ['开始牵引', '提交确认', '确认完成'][step]
  if (action !== expectedAction) {
    return { ok: false, message: `任务处于「${current}」，只能执行「${expectedAction}」进入「${target}」，不许跳步` }
  }
  if (current === '待牵引' && String(row[TOW_FIELDS.escortReady]) !== '是') {
    return { ok: false, message: `护送人员「${row[TOW_FIELDS.escort]}」尚未到位，任务不能进入「牵引中」` }
  }

  // 确认完成 = 落位结论：回写停机位占用台账，牵引单与机位台账读到的当前航班必须是同一份。
  if (target === '已完成') {
    const flight = String(row[TOW_FIELDS.flight]).trim()
    const to = String(row[TOW_FIELDS.to]).trim()
    const from = String(row[TOW_FIELDS.from]).trim()
    const standRows = listRows(STAND_KEY)
    const toIndex = standRows.findIndex(
      (item) => String(item[MODULE_STAND_FIELDS.code]).trim() === to,
    )
    if (toIndex < 0) {
      return { ok: false, message: `目标机位「${to}」已不在机位台账中，无法落位` }
    }
    const targetStand = standRows[toIndex]
    const occupiedBy = String(targetStand[MODULE_STAND_FIELDS.flight] ?? '').trim()
    if (String(targetStand.status) !== '空闲' && occupiedBy !== flight) {
      return {
        ok: false,
        message: `落位被拒绝：目标机位「${to}」已被航班「${occupiedBy || targetStand.status}」占用`,
      }
    }

    const nextStands = [...standRows]
    nextStands[toIndex] = {
      ...targetStand,
      status: '占用中',
      pending: true,
      abnormal: false,
      [MODULE_STAND_FIELDS.flight]: flight,
      [MODULE_STAND_FIELDS.period]: todayLabel(),
      [MODULE_STAND_FIELDS.statusText]: '占用中',
    }
    // 原机位上若还是本航班，牵引走后同步释放；若已被后续航班占用则不动台账。
    const fromIndex = nextStands.findIndex(
      (item) => String(item[MODULE_STAND_FIELDS.code]).trim() === from,
    )
    if (fromIndex >= 0) {
      const fromStand = nextStands[fromIndex]
      if (String(fromStand[MODULE_STAND_FIELDS.flight] ?? '').trim() === flight) {
        nextStands[fromIndex] = {
          ...fromStand,
          status: '空闲',
          pending: true,
          abnormal: false,
          [MODULE_STAND_FIELDS.flight]: '—',
          [MODULE_STAND_FIELDS.period]: '—',
          [MODULE_STAND_FIELDS.statusText]: '空闲',
        }
      }
    }
    saveRows(STAND_KEY, nextStands)
  }

  const next = [...rows]
  next[index] = {
    ...row,
    status: target,
    pending: target !== '已完成',
    abnormal: false,
    [TOW_FIELDS.statusText]: target,
  }
  saveRows(TOW_KEY, next)
  const suffix = target === '已完成' ? '，落位结论已回写机位占用台账' : ''
  return { ok: true, message: `任务「${row[TOW_FIELDS.code]}」已${action}，当前状态「${target}」${suffix}` }
}

// 台账对账：每个机位作为起始/目标机位各有多少条牵引任务。
// 与牵引页检索同一份 tow 数据，按机位筛出来的条数必然对得上。
export function standTowCounts(): Record<string, { asFrom: number; asTo: number }> {
  const stats: Record<string, { asFrom: number; asTo: number }> = {}
  for (const stand of listRows(STAND_KEY)) {
    stats[String(stand[MODULE_STAND_FIELDS.code])] = { asFrom: 0, asTo: 0 }
  }
  for (const row of listRows(TOW_KEY)) {
    const from = String(row[TOW_FIELDS.from] ?? '').trim()
    const to = String(row[TOW_FIELDS.to] ?? '').trim()
    if (stats[from]) stats[from].asFrom += 1
    if (stats[to]) stats[to].asTo += 1
  }
  return stats
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// 导出与页面检索共用 filterRows：页面按哪几个字段筛，导出就按哪几个字段筛，不允许两套口径。
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of filterRows(listRows(key), filters)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
