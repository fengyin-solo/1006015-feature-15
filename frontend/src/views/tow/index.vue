<template>
  <section class="page" data-module="tow">
    <header class="page-head">
      <div>
        <h2>航空器牵引管理</h2>
        <p class="page-desc">按起始机位、目标机位、护送人员定位牵引任务；派发校验机位台账，落位结论回写占用台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">派发牵引任务</button>
        <button class="btn" type="button" @click="exportRows">导出航空器牵引清单</button>
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
      <span class="legend-item">其中护送未到位：{{ escortPendingCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>起始机位</span>
        <select v-model="filters['起始机位']">
          <option value="">全部机位</option>
          <option v-for="code in standCodes" :key="`from-${code}`" :value="code">{{ code }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>目标机位</span>
        <select v-model="filters['目标机位']">
          <option value="">全部机位</option>
          <option v-for="code in standCodes" :key="`to-${code}`" :value="code">{{ code }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>护送人员</span>
        <input v-model="filters['护送人员']" placeholder="按护送人员检索" />
      </label>
      <label class="filter-item">
        <span>航班号</span>
        <input v-model="filters['航班号']" placeholder="按航班号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待牵引' && String(row['护送到位']) !== '是'"
              class="link"
              type="button"
              @click="markReady(row)"
            >
              登记护送到位
            </button>
            <button
              v-if="String(row.status) !== '已完成'"
              class="link"
              type="button"
              @click="openTarget(row)"
            >
              改目标机位
            </button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="String(row.status) === '已完成'" class="muted-text">已落位</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">没有符合检索条件的牵引任务，可换个机位或重置条件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条牵引记录，与机位台账同源；导出按当前检索条件（起始机位 / 目标机位 / 护送人员）取数
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3 class="modal-title">派发牵引任务</h3>
        <p class="modal-tip">起始与目标机位不能相同；目标机位被占用、维护或封闭的，整条拒绝。</p>
        <label class="modal-field">
          <span>航班号</span>
          <input v-model="form['航班号']" placeholder="如 HU7802" />
        </label>
        <label class="modal-field">
          <span>牵引车号</span>
          <input v-model="form['牵引车号']" placeholder="如 TG-12" />
        </label>
        <label class="modal-field">
          <span>起始机位</span>
          <select v-model="form['起始机位']">
            <option value="" disabled>请选择起始机位</option>
            <option v-for="code in standCodes" :key="`cf-${code}`" :value="code">{{ code }}</option>
          </select>
        </label>
        <label class="modal-field">
          <span>目标机位</span>
          <select v-model="form['目标机位']">
            <option value="" disabled>请选择目标机位</option>
            <option v-for="code in standCodes" :key="`ct-${code}`" :value="code">{{ code }}</option>
          </select>
        </label>
        <label class="modal-field">
          <span>驾驶员</span>
          <input v-model="form['驾驶员']" placeholder="牵引车驾驶员" />
        </label>
        <label class="modal-field">
          <span>护送人员</span>
          <input v-model="form['护送人员']" placeholder="护送人员姓名" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认派发</button>
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
        </div>
      </form>
    </div>

    <div v-if="targetOpen" class="modal-mask" @click.self="closeTarget">
      <form class="modal-card" @submit.prevent="submitTarget">
        <h3 class="modal-title">修改目标机位</h3>
        <p class="modal-tip">
          任务「{{ targetRow?.['任务编号'] }}」当前目标「{{ targetRow?.['目标机位'] }}」；已完成任务禁止修改。
        </p>
        <label class="modal-field">
          <span>新目标机位</span>
          <select v-model="targetValue">
            <option value="" disabled>请选择目标机位</option>
            <option v-for="code in standCodes" :key="`et-${code}`" :value="code">{{ code }}</option>
          </select>
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认修改</button>
          <button class="btn ghost" type="button" @click="closeTarget">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  changeTowTarget,
  dispatchTow,
  downloadEntries,
  listEntries,
  markTowEscortReady,
  moduleMeta,
  runTowAction,
  standOptions,
} from '@/api/local-service'
import type { DraftRow, EntryRow } from '@/data/types'

const meta = moduleMeta('tow')
const route = useRoute()
const columns = ['任务编号', '航班号', '牵引车号', '起始机位', '目标机位', '驾驶员', '护送人员', '护送到位']
const statuses = ['待牵引', '牵引中', '待确认', '已完成']
const nextActionByStatus: Record<string, string> = {
  待牵引: '开始牵引',
  牵引中: '提交确认',
  待确认: '确认完成',
}
const standCodes = standOptions()

const rows = ref<EntryRow[]>([])
const allRowsCache = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({
  起始机位: '',
  目标机位: '',
  护送人员: '',
  航班号: '',
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allRowsCache.value.filter((row) => String(row.status) === status).length,
  })),
)
const escortPendingCount = computed(
  () =>
    allRowsCache.value.filter(
      (row) => String(row.status) === '待牵引' && String(row['护送到位']) !== '是',
    ).length,
)
const stats = computed(() => [
  { label: '今日牵引任务', value: allRowsCache.value.length },
  {
    label: '牵引中任务',
    value: allRowsCache.value.filter((row) => String(row.status) === '牵引中').length,
  },
  {
    label: '待确认任务',
    value: allRowsCache.value.filter((row) => String(row.status) === '待确认').length,
  },
])

function availableActions(row: EntryRow): string[] {
  const action = nextActionByStatus[String(row.status)]
  return action ? [action] : []
}

function resetFilters() {
  filters.value = { 起始机位: '', 目标机位: '', 护送人员: '', 航班号: '' }
  reload()
}

function exportRows() {
  // 与页面检索同一份 filters，页面按什么筛、导出就按什么筛。
  downloadEntries(meta.key, filters.value)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = runTowAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function markReady(row: EntryRow) {
  errorMessage.value = ''
  const result = markTowEscortReady(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

const createOpen = ref(false)
const form = ref<DraftRow>({
  航班号: '',
  牵引车号: '',
  起始机位: '',
  目标机位: '',
  驾驶员: '',
  护送人员: '',
})
const formError = ref('')

function openCreate() {
  formError.value = ''
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
  formError.value = ''
}

function submitCreate() {
  formError.value = ''
  const result = dispatchTow(form.value)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  createOpen.value = false
  form.value = { 航班号: '', 牵引车号: '', 起始机位: '', 目标机位: '', 驾驶员: '', 护送人员: '' }
  reload()
}

const targetOpen = ref(false)
const targetRow = ref<EntryRow | null>(null)
const targetValue = ref('')

function openTarget(row: EntryRow) {
  targetRow.value = row
  targetValue.value = String(row['目标机位'] ?? '')
  formError.value = ''
  targetOpen.value = true
}

function closeTarget() {
  targetOpen.value = false
  targetRow.value = null
  formError.value = ''
}

function submitTarget() {
  if (!targetRow.value) return
  formError.value = ''
  const result = changeTowTarget(Number(targetRow.value.id), targetValue.value)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeTarget()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    allRowsCache.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航空器牵引列表读取失败'
  }
}

onMounted(() => {
  // 从机位台账点数字跳过来时，按起始/目标机位自动带上检索条件。
  const from = String(route.query.from ?? '')
  const to = String(route.query.to ?? '')
  if (from) filters.value['起始机位'] = from
  if (to) filters.value['目标机位'] = to
  reload()
})
</script>
