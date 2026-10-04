<template>
  <section class="page" data-module="tow">
    <header class="page-head">
      <div>
        <h2>航空器牵引管理</h2>
        <p class="page-desc">
          按起始机位、目标机位、护送人员定位当天牵引任务；派发校验机位占用，落位结论回写机位台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">派发牵引任务</button>
        <button class="btn" type="button" @click="exportRows">导出当前检索结果</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>起始机位</span>
        <input v-model="filters.起始机位" list="stand-code-list" placeholder="按起始机位检索" />
      </label>
      <label class="filter-item">
        <span>目标机位</span>
        <input v-model="filters.目标机位" list="stand-code-list" placeholder="按目标机位检索" />
      </label>
      <label class="filter-item">
        <span>护送人员</span>
        <input v-model="filters.护送人员" placeholder="按护送人员检索" />
      </label>
      <label class="filter-item filter-check">
        <input v-model="onlyToday" type="checkbox" />
        <span>只看当天</span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>
    <datalist id="stand-code-list">
      <option v-for="stand in stands" :key="stand.编号" :value="stand.编号">
        {{ stand.status }} · {{ stand.当前航班 }}
      </option>
    </datalist>

    <!-- 与机位台账对账：检索到几条、涉及哪些机位、台账上当前是什么状态 -->
    <div v-if="reconcile.lines.length" class="reconcile-box">
      <div class="reconcile-head">
        <span>与机位台账核对（同一份数据）</span>
        <span :class="reconcile.matches ? 'ok-text' : 'error-text'">
          {{ reconcile.matches ? '条数已对上' : '存在未登记机位，请核对机位编号' }}
        </span>
      </div>
      <p v-for="line in reconcile.lines" :key="line.code" class="reconcile-line">
        <span>机位 {{ line.code }}</span>
        <span>台账状态：{{ line.status }} / 当前航班：{{ line.flight }}</span>
        <span>命中牵引任务 {{ line.count }} 条</span>
      </p>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '护送到位'">
              <span :class="row.护送到位 === true ? 'ok-text' : 'warn-text'">
                {{ row.护送到位 === true ? '已到位' : '未到位' }}
              </span>
            </template>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="String(row.status) === '待牵引'">
              <button class="link" type="button" @click="doAction('护送到位', row)">护送到位</button>
              <button class="link" type="button" @click="doAction('开始牵引', row)">开始牵引</button>
              <button class="link" type="button" @click="openChangeTarget(row)">改目标机位</button>
            </template>
            <template v-else-if="String(row.status) === '牵引中'">
              <button class="link" type="button" @click="doAction('提交确认', row)">提交确认</button>
            </template>
            <template v-else-if="String(row.status) === '待确认'">
              <button class="link" type="button" @click="doAction('确认完成', row)">确认完成</button>
            </template>
            <template v-else>
              <span class="muted-text">已闭环</span>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前检索条件下没有牵引任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>检索命中 {{ total }} 条（与机位台账同一份数据，导出与此同口径）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 派发牵引任务 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>派发牵引任务</h3>
        <form class="modal-form" @submit.prevent="submitCreate">
          <label v-for="field in createFields" :key="field.prop" class="modal-item">
            <span>{{ field.label }}</span>
            <input
              v-model="createForm[field.prop]"
              :list="field.stand ? 'stand-code-list' : undefined"
              :placeholder="`请输入${field.label}`"
            />
          </label>
          <p class="modal-hint">
            校验规则：起始与目标机位不能相同；目标机位须为台账空闲机位；同一航班只允许一条有效任务。
          </p>
          <div class="modal-actions">
            <button class="btn primary" type="submit">确认派发</button>
            <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 修改目标机位（已完成任务一律拒绝） -->
    <div v-if="targetOpen" class="modal-mask" @click.self="targetOpen = false">
      <div class="modal">
        <h3>改派目标机位</h3>
        <form class="modal-form" @submit.prevent="submitChangeTarget">
          <p class="modal-hint">
            任务 {{ targetForm.任务编号 }}（{{ targetForm.航班号 }}）：{{ targetForm.起始机位 }} →
            <strong>{{ targetForm.原目标 }}</strong>
          </p>
          <label class="modal-item">
            <span>新目标机位</span>
            <input v-model="targetForm.新目标" list="stand-code-list" placeholder="输入台账中空闲机位编号" />
          </label>
          <div class="modal-actions">
            <button class="btn primary" type="submit">确认改派</button>
            <button class="btn ghost" type="button" @click="targetOpen = false">取消</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  advanceTowTask,
  changeTargetStand,
  dispatchTowTask,
  exportTowTasks,
  listStandLedger,
  markEscortArrived,
  queryTowTasks,
  todayText,
  type StandLedger,
  type TowFilters,
} from '@/api/tow-service'
import type { EntryRow } from '@/data/types'

const columns = [
  '任务编号',
  '航班号',
  '牵引车号',
  '起始机位',
  '目标机位',
  '驾驶员',
  '护送人员',
  '护送到位',
  '登记日期',
  '落位结论',
]
const statuses = ['待牵引', '牵引中', '待确认', '已完成']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stands = ref<StandLedger[]>([])
const errorMessage = ref('')
const okMessage = ref('')
const onlyToday = ref(true)
const filters = reactive<TowFilters>({ 起始机位: '', 目标机位: '', 护送人员: '' })

const stats = computed(() => {
  const today = todayText()
  const todayRows = rows.value.filter((row) => String(row.登记日期 ?? '') === today)
  return [
    { label: '今日牵引任务', value: todayRows.length },
    { label: '牵引中任务', value: rows.value.filter((row) => String(row.status) === '牵引中').length },
    { label: '待确认任务', value: rows.value.filter((row) => String(row.status) === '待确认').length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 检索结果与机位台账对账：按筛选中的机位逐个统计命中条数，并核对机位是否在册
const reconcile = computed(() => {
  const queriedCodes = [filters.起始机位?.trim(), filters.目标机位?.trim()].filter(Boolean) as string[]
  const codes = [...new Set(queriedCodes)]
  const lines = codes.map((code) => {
    const stand = stands.value.find((item) => item.编号 === code)
    const count = rows.value.filter(
      (row) => String(row.起始机位) === code || String(row.目标机位) === code,
    ).length
    return {
      code,
      count,
      status: stand ? stand.status : '未登记',
      flight: stand ? stand.当前航班 : '—',
    }
  })
  return { lines, matches: lines.every((line) => line.status !== '未登记') }
})

function activeFilters(): TowFilters {
  return {
    起始机位: filters.起始机位 ?? '',
    目标机位: filters.目标机位 ?? '',
    护送人员: filters.护送人员 ?? '',
    onlyToday: onlyToday.value,
  }
}

function resetFilters() {
  filters.起始机位 = ''
  filters.目标机位 = ''
  filters.护送人员 = ''
  onlyToday.value = true
  reload()
}

function reload() {
  errorMessage.value = ''
  okMessage.value = ''
  const payload = queryTowTasks(activeFilters())
  rows.value = payload.items
  total.value = payload.total
  stands.value = listStandLedger()
}

// 页面查询与导出共用 queryTowTasks：页面按什么筛，导出就按什么筛
function exportRows() {
  const { filename, content } = exportTowTasks(activeFilters())
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  okMessage.value = `已按当前检索条件导出 ${total.value} 条`
}

// ---------- 派发 ----------

type CreateForm = {
  航班号: string
  牵引车号: string
  起始机位: string
  目标机位: string
  驾驶员: string
  护送人员: string
}

const createOpen = ref(false)
const createFields: { prop: keyof CreateForm; label: string; stand?: boolean }[] = [
  { prop: '航班号', label: '航班号' },
  { prop: '牵引车号', label: '牵引车号' },
  { prop: '起始机位', label: '起始机位（台账编号）', stand: true },
  { prop: '目标机位', label: '目标机位（台账编号）', stand: true },
  { prop: '驾驶员', label: '驾驶员' },
  { prop: '护送人员', label: '护送人员' },
]
const createForm = reactive<CreateForm>({
  航班号: '',
  牵引车号: '',
  起始机位: '',
  目标机位: '',
  驾驶员: '',
  护送人员: '',
})

function openCreate() {
  errorMessage.value = ''
  okMessage.value = ''
  Object.assign(createForm, {
    航班号: '',
    牵引车号: '',
    起始机位: '',
    目标机位: '',
    驾驶员: '',
    护送人员: '',
  })
  createOpen.value = true
}

function submitCreate() {
  const result = dispatchTowTask({ ...createForm })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  createOpen.value = false
  okMessage.value = result.message
  reload()
}

// ---------- 状态推进 / 护送到位 ----------

function doAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result =
    action === '护送到位'
      ? markEscortArrived(Number(row.id))
      : advanceTowTask(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

// ---------- 改目标机位 ----------

const targetOpen = ref(false)
const targetForm = reactive({ id: 0, 任务编号: '', 航班号: '', 起始机位: '', 原目标: '', 新目标: '' })

function openChangeTarget(row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  Object.assign(targetForm, {
    id: Number(row.id),
    任务编号: String(row.任务编号),
    航班号: String(row.航班号),
    起始机位: String(row.起始机位),
    原目标: String(row.目标机位),
    新目标: '',
  })
  targetOpen.value = true
}

function submitChangeTarget() {
  const result = changeTargetStand(targetForm.id, targetForm.新目标)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  targetOpen.value = false
  okMessage.value = result.message
  reload()
}

onMounted(reload)
</script>
