import { MODULES } from '@/data/modules'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 牵引模块的领域服务：页面检索和导出共用这一份数据口径，
// 派发校验、状态顺序推进、机位台账回写也都收敛在这里，页面不再各写一套。

const TOW_KEY = 'tow'
const STAND_KEY = 'stand'

// 任务状态只能顺着这条链一步一步走，任何跳步都挡回。
const TOW_FLOW = ['待牵引', '牵引中', '待确认', '已完成'] as const
const TERMINAL_STATUS = '已完成'

const ACTIVE_STATUSES = ['待牵引', '牵引中', '待确认']

const TOW_FIELDS = MODULES.find((item) => item.key === TOW_KEY)!.fields

export type TowFilters = {
  起始机位?: string
  目标机位?: string
  护送人员?: string
  // 默认只看当天（按登记日期）；传 false 才看全部。
  onlyToday?: boolean
}

export type TowQueryResult = {
  items: EntryRow[]
  total: number
}

export type StandLedger = {
  编号: string
  status: string
  当前航班: string
}

export function todayText(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

// ---------- 机位台账：牵引任务和机位台账读的是同一个 store，不存在两份账 ----------

function standLedger(): { rows: EntryRow[]; byCode: Map<string, EntryRow> } {
  const rows = listRows(STAND_KEY)
  const byCode = new Map<string, EntryRow>()
  for (const row of rows) {
    byCode.set(text(row, '机位编号'), row)
  }
  return { rows, byCode }
}

export function listStandLedger(): StandLedger[] {
  return standLedger().rows.map((row) => ({
    编号: text(row, '机位编号'),
    status: String(row.status),
    当前航班: text(row, '当前航班'),
  }))
}

function saveStandLedger(rows: EntryRow[]): void {
  saveRows(STAND_KEY, rows)
}

function releaseStand(row: EntryRow): EntryRow {
  return {
    ...row,
    status: '空闲',
    pending: true,
    当前航班: '—',
    占用时段: '—',
    机位状态: '可分配',
  }
}

function occupyStand(row: EntryRow, flight: string, date: string): EntryRow {
  return {
    ...row,
    status: '占用中',
    pending: true,
    当前航班: flight,
    占用时段: `${date} 起`,
    机位状态: '航班停靠中',
  }
}

// ---------- 统一检索：列表与导出都走这一个口径 ----------

// 与机位台账对口径时用得到：检索条件只认登记在册的机位字段，
// 不会出现页面按「起始机位」筛、导出却按别的字段筛的情况。
export function queryTowTasks(filters: TowFilters = {}): TowQueryResult {
  const onlyToday = filters.onlyToday !== false
  const today = todayText()
  const from = (filters.起始机位 ?? '').trim()
  const target = (filters.目标机位 ?? '').trim()
  const escort = (filters.护送人员 ?? '').trim()

  const items = listRows(TOW_KEY).filter((row) => {
    if (onlyToday && text(row, '登记日期') !== today) {
      return false
    }
    // 机位字段按台账编号精确匹配（编号是台账主键，模糊匹配会把 101 和 1101 混在一起）
    if (from && text(row, '起始机位') !== from) {
      return false
    }
    if (target && text(row, '目标机位') !== target) {
      return false
    }
    // 护送人员按包含匹配，方便只记得姓也能查
    if (escort && !text(row, '护送人员').includes(escort)) {
      return false
    }
    return true
  })

  return { items, total: items.length }
}

// 导出与页面检索共用 queryTowTasks，筛出来多少条就导出多少条。
export function exportTowTasks(filters: TowFilters = {}): { filename: string; content: string } {
  const { items } = queryTowTasks(filters)
  const header = ['编号', ...TOW_FIELDS, '当前状态']
  const lines = [header.join(',')]
  for (const row of items) {
    lines.push([row.id, ...TOW_FIELDS.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: '航空器牵引-清单.csv', content: `﻿${lines.join('\n')}` }
}

// 同一航班只允许一条有效（未完成）记录；已完成的历史不挡新任务。
function activeTaskOfFlight(flight: string, excludeId?: number): EntryRow | undefined {
  return listRows(TOW_KEY).find(
    (row) =>
      Number(row.id) !== excludeId &&
      text(row, '航班号') === flight &&
      ACTIVE_STATUSES.includes(String(row.status)),
  )
}

// ---------- 派发（登记）：起始与目标不能相同，目标被占用整条拒绝 ----------

export type TowDraft = {
  航班号: string
  牵引车号: string
  起始机位: string
  目标机位: string
  驾驶员: string
  护送人员: string
}

export function dispatchTowTask(draft: TowDraft): ActionResult {
  const flight = draft.航班号.trim()
  const tractor = draft.牵引车号.trim()
  const from = draft.起始机位.trim()
  const target = draft.目标机位.trim()
  const driver = draft.驾驶员.trim()
  const escort = draft.护送人员.trim()

  for (const [label, value] of [
    ['航班号', flight],
    ['牵引车号', tractor],
    ['起始机位', from],
    ['目标机位', target],
    ['驾驶员', driver],
    ['护送人员', escort],
  ] as const) {
    if (!value) {
      return { ok: false, message: `${label}不能为空` }
    }
  }

  // 起始与目标机位不能相同
  if (from === target) {
    return { ok: false, message: `起始机位与目标机位不能相同（均为 ${from}），请重新派发` }
  }

  const { byCode } = standLedger()
  const fromStand = byCode.get(from)
  if (!fromStand) {
    return { ok: false, message: `起始机位 ${from} 不在机位台账中，无法派发` }
  }
  const targetStand = byCode.get(target)
  if (!targetStand) {
    return { ok: false, message: `目标机位 ${target} 不在机位台账中，无法派发` }
  }

  // 目标机位必须处于空闲：占用 / 维护 / 封闭都不能接收，整条拒绝不留半截记录
  if (String(targetStand.status) !== '空闲' || text(targetStand, '当前航班') !== '—') {
    const occupiedBy = text(targetStand, '当前航班')
    return {
      ok: false,
      message: `目标机位 ${target} 当前为「${targetStand.status}」${
        occupiedBy !== '—' ? `，已被航班 ${occupiedBy} 占用` : '，不可接收牵引任务'
      }，任务整条拒绝`,
    }
  }

  // 起始机位须由本航班实际占着，防止从别的机位拖错飞机
  if (String(fromStand.status) !== '占用中') {
    return { ok: false, message: `起始机位 ${from} 当前为「${fromStand.status}」，没有待牵引的航班` }
  }
  if (text(fromStand, '当前航班') !== flight) {
    return {
      ok: false,
      message: `起始机位 ${from} 上当前是航班 ${text(fromStand, '当前航班')}，与任务航班 ${flight} 不一致`,
    }
  }

  // 同一航班重复牵引只留一条有效记录
  const duplicated = activeTaskOfFlight(flight)
  if (duplicated) {
    return {
      ok: false,
      message: `航班 ${flight} 已存在有效牵引任务 ${text(duplicated, '任务编号')}（${duplicated.status}），重复牵引不予登记`,
    }
  }

  const rows = listRows(TOW_KEY)
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const today = todayText()
  const row: EntryRow = {
    id: nextId,
    status: '待牵引',
    pending: true,
    abnormal: false,
    任务编号: `TOW-${String(nextId).padStart(4, '0')}`,
    航班号: flight,
    牵引车号: tractor,
    起始机位: from,
    目标机位: target,
    驾驶员: driver,
    护送人员: escort,
    护送到位: false,
    登记日期: today,
    落位结论: '',
    任务状态: '待牵引',
  }
  saveRows(TOW_KEY, [...rows, row])
  return { ok: true, message: `牵引任务 ${row.任务编号} 已派发：${from} → ${target}，等待护送人员到位` }
}

// ---------- 护送到位：没到位的进不了「牵引中」 ----------

export function markEscortArrived(id: number): ActionResult {
  const rows = listRows(TOW_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的牵引任务` }
  }
  const current = String(rows[index].status)
  if (current !== '待牵引') {
    return { ok: false, message: `任务已${current}，护送到位登记只在待牵引时有效` }
  }
  if (rows[index].护送到位 === true) {
    return { ok: false, message: '护送人员已登记到位，无需重复登记' }
  }
  const next = [...rows]
  next[index] = { ...rows[index], 护送到位: true }
  saveRows(TOW_KEY, next)
  return { ok: true, message: '护送人员已到位，可以开始牵引' }
}

// ---------- 修改目标机位：仅待牵引可改；已完成后再改一律拒绝 ----------

export function changeTargetStand(id: number, nextTarget: string): ActionResult {
  const target = nextTarget.trim()
  if (!target) {
    return { ok: false, message: '目标机位不能为空' }
  }
  const rows = listRows(TOW_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的牵引任务` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === TERMINAL_STATUS) {
    return { ok: false, message: '任务已完成，落位结论已回写机位台账，目标机位一律不得再改' }
  }
  if (current !== '待牵引') {
    return { ok: false, message: `任务已${current}，飞机在牵引途中，不允许再改目标机位` }
  }
  const from = text(row, '起始机位')
  if (target === from) {
    return { ok: false, message: `目标机位不能与起始机位 ${from} 相同` }
  }
  const { byCode } = standLedger()
  const targetStand = byCode.get(target)
  if (!targetStand) {
    return { ok: false, message: `目标机位 ${target} 不在机位台账中` }
  }
  if (String(targetStand.status) !== '空闲' || text(targetStand, '当前航班') !== '—') {
    const occupiedBy = text(targetStand, '当前航班')
    return {
      ok: false,
      message: `目标机位 ${target} 当前为「${targetStand.status}」${
        occupiedBy !== '—' ? `，已被航班 ${occupiedBy} 占用` : '，不可接收牵引任务'
      }，不能改派`,
    }
  }
  const next = [...rows]
  next[index] = { ...row, 目标机位: target }
  saveRows(TOW_KEY, next)
  return { ok: true, message: `任务 ${text(row, '任务编号')} 的目标机位已改派为 ${target}` }
}

// ---------- 状态推进：严格按 待牵引→牵引中→待确认→已完成 顺序 ----------

export function advanceTowTask(id: number, action: string): ActionResult {
  const actionToTarget: Record<string, string> = {
    开始牵引: '牵引中',
    提交确认: '待确认',
    确认完成: '已完成',
  }
  const target = actionToTarget[action]
  if (!target) {
    return { ok: false, message: `牵引任务没有登记「${action}」这个动作` }
  }

  const rows = listRows(TOW_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的牵引任务` }
  }
  const row = rows[index]
  const current = String(row.status)

  // 顺序校验：只允许从相邻的上一个状态进入目标状态，跳步挡回
  const currentIndex = TOW_FLOW.indexOf(current as (typeof TOW_FLOW)[number])
  const targetIndex = TOW_FLOW.indexOf(target as (typeof TOW_FLOW)[number])
  if (currentIndex < 0) {
    return { ok: false, message: `任务当前状态「${current}」不在牵引流转链上，禁止操作` }
  }
  if (targetIndex !== currentIndex + 1) {
    return {
      ok: false,
      message: `牵引任务只能按 待牵引 → 牵引中 → 待确认 → 已完成 逐步推进，当前「${current}」不能直接${action}到「${target}」`,
    }
  }

  const { rows: standRows, byCode } = standLedger()
  const flight = text(row, '航班号')
  const from = text(row, '起始机位')
  const targetStandCode = text(row, '目标机位')
  const date = text(row, '登记日期') || todayText()

  if (target === '牵引中') {
    // 护送人员没到位的进不了牵引中
    if (row.护送到位 !== true) {
      return { ok: false, message: '护送人员尚未到位（对讲机确认并登记「护送到位」后才能开始牵引）' }
    }
    // 开始牵引即把飞机从起始机位挪走：释放起始机位
    const fromStand = byCode.get(from)
    if (fromStand && (String(fromStand.status) === '占用中' && text(fromStand, '当前航班') === flight)) {
      const standIndex = standRows.findIndex((item) => Number(item.id) === Number(fromStand.id))
      standRows[standIndex] = releaseStand(fromStand)
      saveStandLedger(standRows)
    }
  }

  if (target === '已完成') {
    // 落位前再校验一次目标机位：途中被别的保障占了就不能落位，整条不回写
    const targetStand = byCode.get(targetStandCode)
    if (!targetStand) {
      return { ok: false, message: `目标机位 ${targetStandCode} 已不在机位台账中，无法落位` }
    }
    if (String(targetStand.status) !== '空闲' || text(targetStand, '当前航班') !== '—') {
      return {
        ok: false,
        message: `目标机位 ${targetStandCode} 已被航班 ${text(targetStand, '当前航班') || '其他作业'} 占用，落位被拒绝，请先改派目标机位`,
      }
    }
    // 落位结论回写占用台账：目标机位置为占用中，当前航班写本航班
    const standIndex = standRows.findIndex((item) => Number(item.id) === Number(targetStand.id))
    standRows[standIndex] = occupyStand(targetStand, flight, date)
    saveStandLedger(standRows)
  }

  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== TERMINAL_STATUS,
    abnormal: false,
    任务状态: target,
    落位结论: target === '已完成' ? '正常落位' : text(row, '落位结论'),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(TOW_KEY, next)

  const ledgerNote =
    target === '已完成'
      ? `，落位结论已回写机位台账：${targetStandCode} 占用中 / 当前航班 ${flight}`
      : target === '牵引中'
        ? `，起始机位 ${from} 已释放`
        : ''
  return { ok: true, message: `任务已${action}，当前状态「${target}」${ledgerNote}` }
}
