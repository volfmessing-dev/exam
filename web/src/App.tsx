import './App.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import dataset from './data/questions.json'

type Question = {
  discipline: string
  question: string
  options: string[]
  answer: number[]
  multi: boolean
}

type Dataset = {
  version: number
  source: string
  questions: Question[]
}

const data = dataset as Dataset

const OPTION_LABELS = ['А', 'Б', 'В', 'Г', 'Д', 'Е']

type BlockStat = { answered: number; correct: number }

type UserStatsV1 = {
  testsCompleted: number
  questionsAnswered: number
  questionsCorrect: number
  blocks: Record<string, BlockStat>
  updatedAt: number
}

type StatsStoreV1 = {
  version: 1
  users: Record<string, UserStatsV1>
}

type UserStats = UserStatsV1 & {
  timeMsTotal: number
  timeMsByBlock: Record<string, number>
}

type StatsStore = {
  version: 2
  users: Record<string, UserStats>
}

type StatsDeltaV1 = {
  version: 1
  nick: string
  questionsAnswered?: number
  questionsCorrect?: number
  testsCompleted?: number
  blocks?: Record<string, BlockStat>
  timeMsTotal?: number
  timeMsByBlock?: Record<string, number>
  createdAt: number
}

const STATS_KEY_V1 = 'gosi_stats_v1'
const STATS_KEY_V2 = 'gosi_stats_v2'
const STATS_OUTBOX_KEY_V1 = 'gosi_stats_outbox_v1'
const RUN_KEY_V1 = 'gosi_run_v1'
const NICKNAME_KEY = 'gosi_nickname'
const ADMIN_TOKEN_KEY = 'gosi_admin_token'

const STATS_API_BASE = String(import.meta.env.VITE_STATS_API_BASE || '').replace(/\/+$/, '')

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function loadStats(): StatsStore {
  const parsedV2 = safeJsonParse<StatsStore>(localStorage.getItem(STATS_KEY_V2))
  if (parsedV2 && parsedV2.version === 2 && parsedV2.users) return parsedV2

  const parsedV1 = safeJsonParse<StatsStoreV1>(localStorage.getItem(STATS_KEY_V1))
  if (parsedV1 && parsedV1.version === 1 && parsedV1.users) {
    const migrated: StatsStore = {
      version: 2,
      users: Object.keys(parsedV1.users).reduce<Record<string, UserStats>>((acc, nick) => {
        const st = parsedV1.users[nick]!
        acc[nick] = { ...st, timeMsTotal: 0, timeMsByBlock: {} }
        return acc
      }, {}),
    }
    localStorage.setItem(STATS_KEY_V2, JSON.stringify(migrated))
    return migrated
  }

  return { version: 2, users: {} }
}

function saveStats(store: StatsStore): void {
  localStorage.setItem(STATS_KEY_V2, JSON.stringify(store))
}

function loadOutbox(): StatsDeltaV1[] {
  const parsed = safeJsonParse<unknown>(localStorage.getItem(STATS_OUTBOX_KEY_V1))
  if (!Array.isArray(parsed)) return []
  return parsed.filter((d): d is StatsDeltaV1 => !!d && typeof d === 'object' && (d as StatsDeltaV1).version === 1 && typeof (d as StatsDeltaV1).nick === 'string')
}

function saveOutbox(items: StatsDeltaV1[]): void {
  localStorage.setItem(STATS_OUTBOX_KEY_V1, JSON.stringify(items))
}

function applyDeltaToStore(store: StatsStore, delta: StatsDeltaV1, now = Date.now()): StatsStore {
  const nick = delta.nick.trim()
  if (!nick) return store

  const prev = store.users[nick] ?? {
    testsCompleted: 0,
    questionsAnswered: 0,
    questionsCorrect: 0,
    blocks: {},
    timeMsTotal: 0,
    timeMsByBlock: {},
    updatedAt: now,
  }

  const nextBlocks = Object.keys(delta.blocks ?? {}).reduce<Record<string, BlockStat>>((acc, block) => {
    const add = (delta.blocks ?? {})[block]!
    const prevBlock = acc[block] ?? { answered: 0, correct: 0 }
    acc[block] = {
      answered: prevBlock.answered + Math.max(0, add.answered ?? 0),
      correct: prevBlock.correct + Math.max(0, add.correct ?? 0),
    }
    return acc
  }, { ...prev.blocks })

  const nextTimeByBlock = Object.keys(delta.timeMsByBlock ?? {}).reduce<Record<string, number>>((acc, block) => {
    acc[block] = (acc[block] ?? 0) + Math.max(0, (delta.timeMsByBlock ?? {})[block] ?? 0)
    return acc
  }, { ...(prev.timeMsByBlock ?? {}) })

  const nextUser: UserStats = {
    ...prev,
    testsCompleted: prev.testsCompleted + Math.max(0, delta.testsCompleted ?? 0),
    questionsAnswered: prev.questionsAnswered + Math.max(0, delta.questionsAnswered ?? 0),
    questionsCorrect: prev.questionsCorrect + Math.max(0, delta.questionsCorrect ?? 0),
    blocks: nextBlocks,
    timeMsTotal: (prev.timeMsTotal ?? 0) + Math.max(0, delta.timeMsTotal ?? 0),
    timeMsByBlock: nextTimeByBlock,
    updatedAt: now,
  }

  return { ...store, users: { ...store.users, [nick]: nextUser } }
}

function pushDeltaToOutbox(delta: StatsDeltaV1): void {
  const hasAny =
    (delta.testsCompleted ?? 0) > 0 ||
    (delta.questionsAnswered ?? 0) > 0 ||
    (delta.questionsCorrect ?? 0) > 0 ||
    (delta.timeMsTotal ?? 0) > 0 ||
    Object.keys(delta.blocks ?? {}).length > 0 ||
    Object.keys(delta.timeMsByBlock ?? {}).length > 0
  if (!hasAny) return

  const outbox = loadOutbox()
  const idx = outbox.findIndex((d) => d.nick === delta.nick)
  if (idx === -1) {
    outbox.push(delta)
  } else {
    const prev = outbox[idx]!
    const nextBlocks = Object.keys({ ...(prev.blocks ?? {}), ...(delta.blocks ?? {}) }).reduce<Record<string, BlockStat>>((acc, block) => {
      const a = (prev.blocks ?? {})[block] ?? { answered: 0, correct: 0 }
      const b = (delta.blocks ?? {})[block] ?? { answered: 0, correct: 0 }
      acc[block] = { answered: Math.max(0, a.answered) + Math.max(0, b.answered), correct: Math.max(0, a.correct) + Math.max(0, b.correct) }
      return acc
    }, {})

    const nextTimeByBlock = Object.keys({ ...(prev.timeMsByBlock ?? {}), ...(delta.timeMsByBlock ?? {}) }).reduce<Record<string, number>>((acc, block) => {
      acc[block] = Math.max(0, (prev.timeMsByBlock ?? {})[block] ?? 0) + Math.max(0, (delta.timeMsByBlock ?? {})[block] ?? 0)
      return acc
    }, {})

    outbox[idx] = {
      version: 1,
      nick: prev.nick,
      testsCompleted: Math.max(0, prev.testsCompleted ?? 0) + Math.max(0, delta.testsCompleted ?? 0),
      questionsAnswered: Math.max(0, prev.questionsAnswered ?? 0) + Math.max(0, delta.questionsAnswered ?? 0),
      questionsCorrect: Math.max(0, prev.questionsCorrect ?? 0) + Math.max(0, delta.questionsCorrect ?? 0),
      blocks: nextBlocks,
      timeMsTotal: Math.max(0, prev.timeMsTotal ?? 0) + Math.max(0, delta.timeMsTotal ?? 0),
      timeMsByBlock: nextTimeByBlock,
      createdAt: prev.createdAt,
    }
  }
  saveOutbox(outbox)
}

async function fetchJsonWithTimeout(url: string, ms: number): Promise<unknown | null> {
  const ctrl = new AbortController()
  const id = window.setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    window.clearTimeout(id)
  }
}

async function postJsonWithTimeout(url: string, body: unknown, ms: number, extra?: { headers?: Record<string, string> }): Promise<boolean> {
  const ctrl = new AbortController()
  const id = window.setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(extra?.headers ?? {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(id)
  }
}

async function postJsonGetJsonWithTimeout(
  url: string,
  body: unknown,
  ms: number,
  extra?: { headers?: Record<string, string> }
): Promise<unknown | null> {
  const ctrl = new AbortController()
  const id = window.setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(extra?.headers ?? {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    window.clearTimeout(id)
  }
}

function apiUrl(pathname: string): string {
  if (!STATS_API_BASE) return pathname
  return `${STATS_API_BASE}${pathname}`
}

async function probeRemote(): Promise<boolean> {
  const res = await fetchJsonWithTimeout(apiUrl('/api/health'), 1500)
  return !!res && typeof res === 'object'
}

async function hydrateUserStatsFromRemote(nick: string): Promise<void> {
  const clean = nick.trim()
  if (!clean) return

  const remoteRaw = await fetchJsonWithTimeout(apiUrl(`/api/stats/user?nick=${encodeURIComponent(clean)}`), 2500)
  if (!remoteRaw || typeof remoteRaw !== 'object') return
  const payload = remoteRaw as { ok?: boolean; version?: number; user?: unknown }
  if (!payload.ok || payload.version !== 1) return

  const userRaw = (payload as { user?: unknown }).user
  if (userRaw === null || userRaw === undefined) return
  if (typeof userRaw !== 'object') return
  const user = userRaw as Partial<UserStats>
  if (typeof user.testsCompleted !== 'number') return
  if (typeof user.questionsAnswered !== 'number') return
  if (typeof user.questionsCorrect !== 'number') return
  if (typeof user.updatedAt !== 'number') return
  if (!user.blocks || typeof user.blocks !== 'object') return

  const store = loadStats()
  saveStats({ ...store, users: { ...store.users, [clean]: user as UserStats } })

  // Re-apply local pending deltas (outbox) on top.
  const outbox = loadOutbox()
  if (!outbox.length) return
  const now = Date.now()
  const merged = outbox.reduce((acc, d) => applyDeltaToStore(acc, d, now), loadStats())
  saveStats(merged)
}

async function hydrateStatsFromRemoteAdmin(token: string): Promise<boolean> {
  const ctrl = new AbortController()
  const id = window.setTimeout(() => ctrl.abort(), 3500)
  try {
    const res = await fetch(apiUrl('/api/admin/stats'), { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return false
    const json = (await res.json()) as unknown
    if (!json || typeof json !== 'object') return false
    const remote = json as Partial<StatsStore>
    if (remote.version !== 2 || !remote.users || typeof remote.users !== 'object') return false

    saveStats(remote as StatsStore)
    const outbox = loadOutbox()
    if (!outbox.length) return true

    const now = Date.now()
    const merged = outbox.reduce((acc, d) => applyDeltaToStore(acc, d, now), loadStats())
    saveStats(merged)
    void flushOutbox()
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(id)
  }
}

async function flushOutbox(): Promise<void> {
  const outbox = loadOutbox()
  if (!outbox.length) return

  for (let i = 0; i < outbox.length; i++) {
    const delta = outbox[i]!
    const ok = await postJsonWithTimeout(apiUrl('/api/stats/delta'), delta, 2500)
    if (!ok) {
      // If remote is down, stop to avoid burning requests.
      saveOutbox(outbox.slice(i))
      return
    }
  }

  saveOutbox([])
}

async function adminVerifyRemote(token: string): Promise<boolean> {
  const ctrl = new AbortController()
  const id = window.setTimeout(() => ctrl.abort(), 2500)
  try {
    const res = await fetch(apiUrl('/api/admin/verify'), { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return false
    const json = (await res.json()) as unknown
    return !!json && typeof json === 'object' && !!(json as { ok?: boolean }).ok
  } catch {
    return false
  } finally {
    window.clearTimeout(id)
  }
}

async function adminLoginRemote(login: string, password: string): Promise<{ token: string } | null> {
  const json = await postJsonGetJsonWithTimeout(apiUrl('/api/admin/login'), { version: 1, login, password }, 4000)
  if (!json || typeof json !== 'object') return null
  const token = (json as { token?: unknown }).token
  if (typeof token !== 'string' || !token) return null
  return { token }
}

async function deleteUsersRemote(token: string, nicks: string[]): Promise<boolean> {
  const payload = { version: 1, nicks }
  return await postJsonWithTimeout(apiUrl('/api/stats/users/delete'), payload, 4000, { headers: { Authorization: `Bearer ${token}` } })
}

function upsertBlock(prev: Record<string, BlockStat>, block: string, ok: boolean): Record<string, BlockStat> {
  const current = prev[block] ?? { answered: 0, correct: 0 }
  return {
    ...prev,
    [block]: {
      answered: current.answered + 1,
      correct: current.correct + (ok ? 1 : 0),
    },
  }
}

function percent(correct: number, total: number): string {
  if (!total) return '—'
  return `${Math.round((correct / total) * 100)}%`
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)

  const pad2 = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}

function shuffleInPlace<T>(arr: T[], seed: number): void {
  // Fisher-Yates; seed makes shuffling stable per run (no crypto).
  let x = seed | 0
  const rand = () => {
    // xorshift32
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) % 1_000_000) / 1_000_000
  }

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function evaluateAnswer(picked: number[], answer: number[]): { ok: boolean; partial: boolean } {
  const pickedSet = new Set(picked)
  const answerSet = new Set(answer)
  const hasWrong = picked.some((i) => !answerSet.has(i))
  const missingAny = answer.some((i) => !pickedSet.has(i))
  const ok = !hasWrong && !missingAny && pickedSet.size === answerSet.size
  const partial = !ok && !hasWrong && picked.length > 0 && missingAny
  return { ok, partial }
}

type Screen = 'setup' | 'quiz' | 'result'

type RunState = {
  version: 1
  screen: 'quiz'
  discipline: string
  shuffle: boolean
  activeNickname: string | null
  quizSourceIndices: number[]
  queue: number[]
  picked: number[]
  reveal: 'none' | 'checked'
  answered: number
  correct: number
  lastWasCorrect: boolean | null
  lastWasPartial: boolean
  runBlocks: Record<string, BlockStat>
  timeCommittedMs: number
  blockTimeCommittedMs: Record<string, number>
  syncedAnswered: number
  syncedCorrect: number
  syncedRunBlocks: Record<string, BlockStat>
  syncedTimeCommittedMs: number
  syncedBlockTimeCommittedMs: Record<string, number>
  savedAt: number
}

function App() {
  const disciplines = useMemo(() => {
    return Array.from(new Set(data.questions.map((q) => q.discipline))).sort()
  }, [])

  const [screen, setScreen] = useState<Screen | 'admin'>('setup')
  const [discipline, setDiscipline] = useState<string>('__all__')
  const [shuffle, setShuffle] = useState<boolean>(true)
  const [nickname, setNickname] = useState<string>(() => localStorage.getItem(NICKNAME_KEY) ?? '')
  const [activeNickname, setActiveNickname] = useState<string | null>(null)
  const [adminAuthed, setAdminAuthed] = useState<boolean>(false)
  const [adminSelectedUsers, setAdminSelectedUsers] = useState<Record<string, boolean>>({})
  const [adminLogin, setAdminLogin] = useState<string>('')
  const [adminPassword, setAdminPassword] = useState<string>('')
  const [adminAuthBusy, setAdminAuthBusy] = useState<boolean>(false)

  const [quizSourceIndices, setQuizSourceIndices] = useState<number[]>([])
  const [quiz, setQuiz] = useState<Question[]>([])
  const [queue, setQueue] = useState<number[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [reveal, setReveal] = useState<'none' | 'checked'>('none')
  const [runBlocks, setRunBlocks] = useState<Record<string, BlockStat>>({})

  const [answered, setAnswered] = useState<number>(0)
  const [correct, setCorrect] = useState<number>(0)
  const [lastWasCorrect, setLastWasCorrect] = useState<boolean | null>(null)
  const [lastWasPartial, setLastWasPartial] = useState<boolean>(false)

  const questionStartedAtRef = useRef<number | null>(null)
  const timeCommittedMsRef = useRef<number>(0)
  const blockTimeCommittedMsRef = useRef<Record<string, number>>({})

  const statsSyncedAnsweredRef = useRef<number>(0)
  const statsSyncedCorrectRef = useRef<number>(0)
  const statsSyncedRunBlocksRef = useRef<Record<string, BlockStat>>({})
  const statsSyncedTimeCommittedMsRef = useRef<number>(0)
  const statsSyncedBlockTimeCommittedMsRef = useRef<Record<string, number>>({})
  const remoteAvailableRef = useRef<boolean>(false)
  const lastRemoteAttemptAtRef = useRef<number>(0)
  const adminTokenRef = useRef<string | null>(sessionStorage.getItem(ADMIN_TOKEN_KEY))

  const [timerNow, setTimerNow] = useState<number>(() => Date.now())
  const [questionStartedAt, setQuestionStartedAt] = useState<number | null>(null)
  const [timeCommittedMs, setTimeCommittedMs] = useState<number>(0)
  const [blockTimeCommittedMs, setBlockTimeCommittedMs] = useState<Record<string, number>>({})

  const current = queue.length ? quiz[queue[0]!] : undefined

  useEffect(() => {
    localStorage.setItem(NICKNAME_KEY, nickname)
  }, [nickname])

  useEffect(() => {
    const init = async () => {
      lastRemoteAttemptAtRef.current = Date.now()
      const ok = await probeRemote()
      remoteAvailableRef.current = ok
      if (!ok) return
      await flushOutbox()
    }
    void init()
  }, [])

  useEffect(() => {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY)
    if (!token) return
    const verify = async () => {
      const ok = await adminVerifyRemote(token)
      if (!ok) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY)
        adminTokenRef.current = null
        setAdminAuthed(false)
        return
      }
      adminTokenRef.current = token
      setAdminAuthed(true)
    }
    void verify()
  }, [])

  const syncAdminNow = async (token: string): Promise<void> => {
    const ok = await probeRemote()
    remoteAvailableRef.current = ok
    if (!ok) return
    await hydrateStatsFromRemoteAdmin(token)
    await flushOutbox()
  }

  useEffect(() => {
    if (screen !== 'admin') return
    if (!adminAuthed) return
    const token = adminTokenRef.current
    if (!token) return
    void syncAdminNow(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, adminAuthed])

  const maybeSyncRemote = (now = Date.now()) => {
    const cooldownMs = 5000
    if (now - lastRemoteAttemptAtRef.current < cooldownMs) return
    lastRemoteAttemptAtRef.current = now

    const run = async () => {
      if (!remoteAvailableRef.current) {
        const ok = await probeRemote()
        remoteAvailableRef.current = ok
        if (!ok) return
      }
      await flushOutbox()
    }
    void run()
  }

  useEffect(() => {
    const snapshotRaw = safeJsonParse<unknown>(sessionStorage.getItem(RUN_KEY_V1))
    if (!snapshotRaw || typeof snapshotRaw !== 'object') return
    const snapshot = snapshotRaw as Partial<RunState>
    if (snapshot.version !== 1 || snapshot.screen !== 'quiz') return

    const quizSourceIndices = snapshot.quizSourceIndices
    const queue = snapshot.queue
    if (!Array.isArray(quizSourceIndices) || quizSourceIndices.length === 0) return
    if (!Array.isArray(queue) || queue.length === 0) return
    if (!quizSourceIndices.every((i) => Number.isInteger(i) && i >= 0 && i < data.questions.length)) return
    if (!queue.every((q) => Number.isInteger(q) && q >= 0 && q < quizSourceIndices.length)) return

    const now = Date.now()
    const restoredQuiz = quizSourceIndices.map((i) => data.questions[i]!)

    setDiscipline(snapshot.discipline ?? '__all__')
    setShuffle(!!snapshot.shuffle)
    setActiveNickname(snapshot.activeNickname ?? null)
    setQuizSourceIndices(quizSourceIndices)
    setQuiz(restoredQuiz)
    setQueue(queue)
    setPicked(snapshot.picked ?? [])
    setReveal(snapshot.reveal ?? 'none')
    setAnswered(snapshot.answered ?? 0)
    setCorrect(snapshot.correct ?? 0)
    setLastWasCorrect(snapshot.lastWasCorrect ?? null)
    setLastWasPartial(snapshot.lastWasPartial ?? false)
    setRunBlocks(snapshot.runBlocks ?? {})

    questionStartedAtRef.current = now
    timeCommittedMsRef.current = snapshot.timeCommittedMs ?? 0
    blockTimeCommittedMsRef.current = snapshot.blockTimeCommittedMs ?? {}

    statsSyncedAnsweredRef.current = snapshot.syncedAnswered ?? 0
    statsSyncedCorrectRef.current = snapshot.syncedCorrect ?? 0
    statsSyncedRunBlocksRef.current = snapshot.syncedRunBlocks ?? {}
    statsSyncedTimeCommittedMsRef.current = snapshot.syncedTimeCommittedMs ?? 0
    statsSyncedBlockTimeCommittedMsRef.current = snapshot.syncedBlockTimeCommittedMs ?? {}

    setTimerNow(now)
    setQuestionStartedAt(now)
    setTimeCommittedMs(timeCommittedMsRef.current)
    setBlockTimeCommittedMs(blockTimeCommittedMsRef.current)

    setScreen('quiz')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const buildRunSnapshot = (now = Date.now()): RunState | null => {
    if (screen !== 'quiz') return null
    if (!quizSourceIndices.length) return null
    if (!queue.length) return null

    let timeTotal = timeCommittedMsRef.current
    const byBlock: Record<string, number> = { ...blockTimeCommittedMsRef.current }

    const startedAt = questionStartedAtRef.current
    const headPos = queue[0]!
    const headSourceIndex = quizSourceIndices[headPos]
    const head = typeof headSourceIndex === 'number' ? data.questions[headSourceIndex] : undefined
    if (startedAt !== null && head) {
      const elapsed = Math.max(0, now - startedAt)
      timeTotal += elapsed
      byBlock[head.discipline] = (byBlock[head.discipline] ?? 0) + elapsed
    }

    return {
      version: 1,
      screen: 'quiz',
      discipline,
      shuffle,
      activeNickname,
      quizSourceIndices,
      queue,
      picked,
      reveal,
      answered,
      correct,
      lastWasCorrect,
      lastWasPartial,
      runBlocks,
      timeCommittedMs: timeTotal,
      blockTimeCommittedMs: byBlock,
      syncedAnswered: statsSyncedAnsweredRef.current,
      syncedCorrect: statsSyncedCorrectRef.current,
      syncedRunBlocks: statsSyncedRunBlocksRef.current,
      syncedTimeCommittedMs: statsSyncedTimeCommittedMsRef.current,
      syncedBlockTimeCommittedMs: statsSyncedBlockTimeCommittedMsRef.current,
      savedAt: now,
    }
  }

  const persistRunSnapshot = (now = Date.now()) => {
    const snapshot = buildRunSnapshot(now)
    if (!snapshot) return
    sessionStorage.setItem(RUN_KEY_V1, JSON.stringify(snapshot))
  }

  const clearRunSnapshot = () => {
    sessionStorage.removeItem(RUN_KEY_V1)
  }

  const ensureUserInStats = (nick: string, now = Date.now()) => {
    const store = loadStats()
    const existing = store.users[nick]
    if (existing) return

    const nextUser: UserStats = {
      testsCompleted: 0,
      questionsAnswered: 0,
      questionsCorrect: 0,
      blocks: {},
      timeMsTotal: 0,
      timeMsByBlock: {},
      updatedAt: now,
    }
    saveStats({ ...store, users: { ...store.users, [nick]: nextUser } })
  }

  const syncRunToStats = (now = Date.now(), overrides?: { answered: number; correct: number; runBlocks: Record<string, BlockStat> }) => {
    const nick = activeNickname
    if (!nick) return

    const answeredTotal = overrides?.answered ?? answered
    const correctTotal = overrides?.correct ?? correct
    const runBlocksTotal = overrides?.runBlocks ?? runBlocks

    const deltaAnswered = Math.max(0, answeredTotal - statsSyncedAnsweredRef.current)
    const deltaCorrect = Math.max(0, correctTotal - statsSyncedCorrectRef.current)
    const deltaTime = Math.max(0, timeCommittedMsRef.current - statsSyncedTimeCommittedMsRef.current)

    const deltaRunBlocks: Record<string, BlockStat> = Object.keys(runBlocksTotal).reduce<Record<string, BlockStat>>((acc, block) => {
      const current = runBlocksTotal[block]!
      const prev = statsSyncedRunBlocksRef.current[block] ?? { answered: 0, correct: 0 }
      const answeredDelta = Math.max(0, current.answered - prev.answered)
      const correctDelta = Math.max(0, current.correct - prev.correct)
      if (answeredDelta || correctDelta) acc[block] = { answered: answeredDelta, correct: correctDelta }
      return acc
    }, {})

    const deltaBlockTime: Record<string, number> = Object.keys(blockTimeCommittedMsRef.current).reduce<Record<string, number>>((acc, block) => {
      const current = blockTimeCommittedMsRef.current[block] ?? 0
      const prev = statsSyncedBlockTimeCommittedMsRef.current[block] ?? 0
      const d = Math.max(0, current - prev)
      if (d) acc[block] = d
      return acc
    }, {})

    const hasAnyDelta =
      deltaAnswered > 0 ||
      deltaCorrect > 0 ||
      deltaTime > 0 ||
      Object.keys(deltaRunBlocks).length > 0 ||
      Object.keys(deltaBlockTime).length > 0

    if (!hasAnyDelta) return

    const store = loadStats()
    const user = store.users[nick] ?? {
      testsCompleted: 0,
      questionsAnswered: 0,
      questionsCorrect: 0,
      blocks: {},
      timeMsTotal: 0,
      timeMsByBlock: {},
      updatedAt: now,
    }

    const nextBlocks = Object.keys(deltaRunBlocks).reduce<Record<string, BlockStat>>((acc, block) => {
      const prev = acc[block] ?? { answered: 0, correct: 0 }
      const add = deltaRunBlocks[block]!
      acc[block] = { answered: prev.answered + add.answered, correct: prev.correct + add.correct }
      return acc
    }, { ...user.blocks })

    const nextTimeByBlock = Object.keys(deltaBlockTime).reduce<Record<string, number>>((acc, block) => {
      acc[block] = (acc[block] ?? 0) + (deltaBlockTime[block] ?? 0)
      return acc
    }, { ...(user.timeMsByBlock ?? {}) })

    const nextUser: UserStats = {
      ...user,
      questionsAnswered: user.questionsAnswered + deltaAnswered,
      questionsCorrect: user.questionsCorrect + deltaCorrect,
      blocks: nextBlocks,
      timeMsTotal: (user.timeMsTotal ?? 0) + deltaTime,
      timeMsByBlock: nextTimeByBlock,
      updatedAt: now,
    }

    saveStats({ ...store, users: { ...store.users, [nick]: nextUser } })

    pushDeltaToOutbox({
      version: 1,
      nick,
      questionsAnswered: deltaAnswered,
      questionsCorrect: deltaCorrect,
      blocks: deltaRunBlocks,
      timeMsTotal: deltaTime,
      timeMsByBlock: deltaBlockTime,
      createdAt: now,
    })

    statsSyncedAnsweredRef.current = answeredTotal
    statsSyncedCorrectRef.current = correctTotal
    statsSyncedRunBlocksRef.current = runBlocksTotal
    statsSyncedTimeCommittedMsRef.current = timeCommittedMsRef.current
    statsSyncedBlockTimeCommittedMsRef.current = blockTimeCommittedMsRef.current

    persistRunSnapshot(now)

    // Best-effort background sync.
    maybeSyncRemote(now)
  }

  const bumpTestsCompleted = (nick: string, now = Date.now()) => {
    const store = loadStats()
    const user = store.users[nick] ?? {
      testsCompleted: 0,
      questionsAnswered: 0,
      questionsCorrect: 0,
      blocks: {},
      timeMsTotal: 0,
      timeMsByBlock: {},
      updatedAt: now,
    }
    const nextUser: UserStats = { ...user, testsCompleted: user.testsCompleted + 1, updatedAt: now }
    saveStats({ ...store, users: { ...store.users, [nick]: nextUser } })

    pushDeltaToOutbox({ version: 1, nick, testsCompleted: 1, createdAt: now })
    maybeSyncRemote(now)
  }

  useEffect(() => {
    if (screen !== 'quiz') return
    persistRunSnapshot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, discipline, shuffle, activeNickname, quizSourceIndices, queue, picked, reveal, answered, correct, lastWasCorrect, lastWasPartial, runBlocks])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) persistRunSnapshot()
    }
    const onPageHide = () => persistRunSnapshot()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) maybeSyncRemote(Date.now())
    }
    const onPageHide = () => maybeSyncRemote(Date.now())
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  useEffect(() => {
    if (screen !== 'quiz') return
    const id = window.setInterval(() => persistRunSnapshot(), 1000)
    return () => window.clearInterval(id)
  }, [screen])

  useEffect(() => {
    if (screen !== 'quiz') return
    const id = window.setInterval(() => setTimerNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [screen])

  const commitCurrentQuestionTime = (now = Date.now()) => {
    if (!current) return
    const startedAt = questionStartedAtRef.current
    if (startedAt === null) return

    const delta = Math.max(0, now - startedAt)
    timeCommittedMsRef.current += delta
    const discipline = current.discipline
    blockTimeCommittedMsRef.current = {
      ...blockTimeCommittedMsRef.current,
      [discipline]: (blockTimeCommittedMsRef.current[discipline] ?? 0) + delta,
    }

    questionStartedAtRef.current = now
    setQuestionStartedAt(now)
    setTimeCommittedMs(timeCommittedMsRef.current)
    setBlockTimeCommittedMs(blockTimeCommittedMsRef.current)
  }

  const start = async () => {
    const nick = nickname.trim()
    const filteredIndices =
      discipline === '__all__'
        ? data.questions.map((_, i) => i)
        : data.questions.reduce<number[]>((acc, q, i) => {
            if (q.discipline === discipline) acc.push(i)
            return acc
          }, [])

    if (!filteredIndices.length) {
      window.alert('Нет вопросов для выбранной дисциплины')
      return
    }

    const nextIndices = [...filteredIndices]
    if (shuffle) shuffleInPlace(nextIndices, Date.now())
    const next = nextIndices.map((i) => data.questions[i]!)

    const now = Date.now()
    questionStartedAtRef.current = now
    timeCommittedMsRef.current = 0
    blockTimeCommittedMsRef.current = {}

    statsSyncedAnsweredRef.current = 0
    statsSyncedCorrectRef.current = 0
    statsSyncedRunBlocksRef.current = {}
    statsSyncedTimeCommittedMsRef.current = 0
    statsSyncedBlockTimeCommittedMsRef.current = {}

    setTimerNow(now)
    setQuestionStartedAt(now)
    setTimeCommittedMs(0)
    setBlockTimeCommittedMs({})

    if (nick) {
      if (!remoteAvailableRef.current) remoteAvailableRef.current = await probeRemote()
      if (remoteAvailableRef.current) {
        await hydrateUserStatsFromRemote(nick)
        await flushOutbox()
      }
      ensureUserInStats(nick, now)
    }

    setQuizSourceIndices(nextIndices)
    setQuiz(next)
    setQueue(next.map((_, i) => i))
    setPicked([])
    setReveal('none')
    setAnswered(0)
    setCorrect(0)
    setRunBlocks({})
    setLastWasCorrect(null)
    setLastWasPartial(false)
    setActiveNickname(nick ? nick : null)
    setScreen('quiz')
  }

  const togglePick = (optionIndex: number) => {
    if (!current) return
    if (reveal !== 'none') return

    if (!current.multi) {
      setPicked([optionIndex])
      return
    }

    setPicked((prev) => {
      if (prev.includes(optionIndex)) return prev.filter((x) => x !== optionIndex)
      return [...prev, optionIndex]
    })
  }

  const check = () => {
    if (!current) return
    const { ok, partial } = evaluateAnswer(picked, current.answer)
    setReveal('checked')
    setLastWasCorrect(ok)
    setLastWasPartial(partial)
  }

  const skip = () => {
    if (reveal !== 'none') return
    const now = Date.now()
    commitCurrentQuestionTime(now)
    syncRunToStats(now)
    setQueue((prev) => {
      if (prev.length <= 1) return prev
      return [...prev.slice(1), prev[0]!]
    })
    setPicked([])
    setLastWasCorrect(null)
    setLastWasPartial(false)
  }

  const next = () => {
    if (!current) return
    if (reveal === 'none') return

    const now = Date.now()
    commitCurrentQuestionTime(now)

    let answeredNext = answered
    let correctNext = correct
    let runBlocksNext = runBlocks

    if (reveal === 'checked' && lastWasCorrect !== null) {
      answeredNext = answered + 1
      correctNext = correct + (lastWasCorrect ? 1 : 0)
      runBlocksNext = upsertBlock(runBlocks, current.discipline, lastWasCorrect)
      setAnswered(answeredNext)
      setCorrect(correctNext)
      setRunBlocks(runBlocksNext)
    }

    const nextQueue = queue.slice(1)
    if (nextQueue.length === 0) {
      syncRunToStats(now, { answered: answeredNext, correct: correctNext, runBlocks: runBlocksNext })
      clearRunSnapshot()
      const nick = activeNickname
      if (nick) {
        bumpTestsCompleted(nick, now)
      }
      setQueue([])
      setScreen('result')
      return
    }

    syncRunToStats(now, { answered: answeredNext, correct: correctNext, runBlocks: runBlocksNext })
    setQueue(nextQueue)
    setPicked([])
    setReveal('none')
    setLastWasCorrect(null)
    setLastWasPartial(false)
  }

  const reset = () => {
    if (screen === 'quiz') {
      const now = Date.now()
      commitCurrentQuestionTime(now)
      syncRunToStats(now)
    }
    setScreen('setup')
    clearRunSnapshot()
    setQuiz([])
    setQuizSourceIndices([])
    setQueue([])
    setPicked([])
    setReveal('none')
    setAnswered(0)
    setCorrect(0)
    setRunBlocks({})
    setLastWasCorrect(null)
    setLastWasPartial(false)
    setActiveNickname(null)

    questionStartedAtRef.current = null
    timeCommittedMsRef.current = 0
    blockTimeCommittedMsRef.current = {}
    setQuestionStartedAt(null)
    setTimeCommittedMs(0)
    setBlockTimeCommittedMs({})
  }

  const openAdmin = () => {
    setAdminSelectedUsers({})
    setScreen('admin')
  }

  const adminLoginSubmit = async () => {
    if (adminAuthBusy) return
    const login = adminLogin.trim()
    const password = adminPassword
    if (!login || !password) return

    setAdminAuthBusy(true)
    try {
      const ok = await probeRemote()
      remoteAvailableRef.current = ok
      if (!ok) return void window.alert('Сервер статистики недоступен')

      const res = await adminLoginRemote(login, password)
      if (!res) return void window.alert('Неверный логин или пароль')

      adminTokenRef.current = res.token
      sessionStorage.setItem(ADMIN_TOKEN_KEY, res.token)
      setAdminAuthed(true)
      setAdminPassword('')
      setAdminSelectedUsers({})
      await syncAdminNow(res.token)
    } finally {
      setAdminAuthBusy(false)
    }
  }

  const adminLogout = () => {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    adminTokenRef.current = null
    setAdminAuthed(false)
    setAdminSelectedUsers({})
    setAdminPassword('')
  }

  const deleteSelectedUsers = async () => {
    const store = loadStats()
    const selected = Object.entries(adminSelectedUsers)
      .filter(([, v]) => !!v)
      .map(([nick]) => nick)
      .filter((nick) => !!store.users[nick])
    if (!selected.length) return void window.alert('Ничего не выбрано')

    const ok = await probeRemote()
    remoteAvailableRef.current = ok
    if (!ok) return void window.alert('Сервер статистики недоступен (удаление отключено)')

    const token = adminTokenRef.current
    if (!token) return void window.alert('Требуется вход в админку')

    const confirm = window.confirm(`Удалить выбранные записи (${selected.length})?`)
    if (!confirm) return

    const remoteOk = await deleteUsersRemote(token, selected)
    if (!remoteOk) return void window.alert('Не удалось удалить на сервере')

    const nextUsers = { ...store.users }
    for (const nick of selected) delete nextUsers[nick]
    saveStats({ ...store, users: nextUsers })
    saveOutbox(loadOutbox().filter((d) => !selected.includes(d.nick)))
    setAdminSelectedUsers({})
    await syncAdminNow(token)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">Test just for fun</div>
        <div className="sub">Test just for fun</div>
      </header>

      {screen === 'setup' && (
        <section className="panel">
          <h1>Запуск</h1>
          <div className="formRow">
            <label className="field">
              Никнейм
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Например: ivan_01"
                inputMode="text"
                autoComplete="nickname"
              />
              <span className="help">Нужен для сохранения статистики</span>
            </label>
            <label className="field fieldDiscipline">
              Дисциплина
              <select
                value={discipline}
                onChange={(e) => setDiscipline(e.target.value)}
              >
                <option value="__all__">Все дисциплины</option>
                {disciplines.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={shuffle}
                onChange={(e) => setShuffle(e.target.checked)}
              />
              Перемешать вопросы
            </label>
          </div>
          <div className="meta">
            В базе: <b>{data.questions.length}</b> вопросов
          </div>
          <div className="actions">
            <button className="primary" onClick={() => void start()}>
              Начать
            </button>
          </div>
        </section>
      )}

      {screen === 'quiz' && current && (
        <section className="panel">
          <div className="topline">
            <div className="progress">
              <div className="progressText">
                Вопрос {answered + 1} из {quiz.length}
              </div>
              <div className="bar">
                <div
                  className="barFill"
                  style={{ width: `${(quiz.length ? answered / quiz.length : 0) * 100}%` }}
                />
              </div>
            </div>
            <div className="score">
              <div>
                Правильно: <b>{correct}</b> / {answered || '—'}
              </div>
              <div>
                Время: <b>{formatDuration(timeCommittedMs + Math.max(0, questionStartedAt ? timerNow - questionStartedAt : 0))}</b>
              </div>
              <div>
                Блок: <b>{formatDuration((blockTimeCommittedMs[current.discipline] ?? 0) + Math.max(0, questionStartedAt ? timerNow - questionStartedAt : 0))}</b>
              </div>
            </div>
          </div>

          <div className="discipline">{current.discipline}</div>
          <h2 className="question">{current.question}</h2>
          {current.multi && <div className="hint">Выберите все правильные варианты</div>}

          <div className="options" role="group" aria-label="Варианты ответа">
            {current.options.map((opt, optionIndex) => {
              const isPicked = picked.includes(optionIndex)
              const isCorrect = current.answer.includes(optionIndex)
              const state =
                reveal === 'none'
                  ? ''
                  : isCorrect
                      ? current.multi && !isPicked
                          ? 'missed'
                          : 'correct'
                      : isPicked
                          ? 'wrong'
                          : ''
              const pickedCls = reveal === 'none' && isPicked ? 'picked' : ''

              return (
                <button
                  key={optionIndex}
                  type="button"
                  className={['option', state, pickedCls].filter(Boolean).join(' ')}
                  onClick={() => togglePick(optionIndex)}
                  aria-pressed={isPicked}
                >
                  <span className="optLabel">
                    {OPTION_LABELS[optionIndex] ?? optionIndex + 1}
                  </span>
                  <span className="optText">{opt}</span>
                </button>
              )
            })}
          </div>

          <div className="actions">
            {reveal === 'none' && (
              <>
                <button className="primary" onClick={check} disabled={picked.length === 0}>
                  Проверить
                </button>
                <button className="ghost" onClick={skip} disabled={queue.length <= 1}>
                  Пропустить
                </button>
              </>
            )}
            {reveal !== 'none' && (
              <>
                {reveal === 'checked' && lastWasCorrect !== null && (
                  <div className={`verdict ${lastWasCorrect ? 'ok' : lastWasPartial ? 'warn' : 'bad'}`}>
                    {lastWasCorrect ? 'Верно' : lastWasPartial ? 'Не все варианты выбраны' : 'Неверно'}
                  </div>
                )}
                <button className="primary" onClick={next}>
                  Дальше
                </button>
              </>
            )}
            <button className="ghost" onClick={reset}>
              Покинуть тест
            </button>
          </div>
        </section>
      )}

      {screen === 'result' && (
        <section className="panel">
          <h1>Результат</h1>
          <div className="resultCard">
            <div className="big">
              {correct} / {quiz.length}
            </div>
            <div className="small">
              Точность: {quiz.length ? Math.round((correct / quiz.length) * 100) : 0}% · Вопросов: {quiz.length}
            </div>
          </div>
          <div className="meta">
            Время: <b>{formatDuration(timeCommittedMs)}</b>
            {' · '}
            Среднее: <b>{answered ? formatDuration(Math.round(timeCommittedMs / answered)) : '—'}</b> / вопрос
          </div>
          {!!Object.keys(blockTimeCommittedMs).length && (
            <div className="adminBlocks">
              {Object.entries(blockTimeCommittedMs)
                .sort((a, b) => b[1] - a[1])
                .map(([block, ms]) => (
                  <div key={block} className="adminBlock">
                    <span className="adminBlockName">{block}</span>
                    <span className="adminBlockKpi">{formatDuration(ms)}</span>
                  </div>
                ))}
            </div>
          )}
          {!!activeNickname && (
            <div className="meta">
              Сохранено для: <b>{activeNickname}</b>
            </div>
          )}
          <div className="actions">
            <button className="primary" onClick={() => void start()} disabled={quiz.length === 0}>
              Пройти еще раз
            </button>
            <button className="ghost" onClick={reset}>
              К настройкам
            </button>
          </div>
        </section>
      )}

	      {screen === 'admin' && (
	        <section className="panel">
	          <h1>Админ: статистика</h1>
	          {!adminAuthed ? (
	            <>
	              <div className="formRow">
	                <label className="field">
	                  Логин
	                  <input
	                    value={adminLogin}
	                    onChange={(e) => setAdminLogin(e.target.value)}
	                    placeholder="admin"
	                    inputMode="text"
	                    autoComplete="username"
	                  />
	                </label>
	                <label className="field">
	                  Пароль
	                  <input
	                    type="password"
	                    value={adminPassword}
	                    onChange={(e) => setAdminPassword(e.target.value)}
	                    placeholder="••••••••"
	                    autoComplete="current-password"
	                  />
	                </label>
	              </div>
	              <div className="actions">
	                <button
	                  className="primary"
	                  onClick={() => void adminLoginSubmit()}
	                  disabled={adminAuthBusy || !adminLogin.trim() || !adminPassword}
	                >
	                  Войти
	                </button>
	              </div>
            </>
	          ) : (
	            <>
	              <div className="actions">
	                <button
                  className="ghost"
                  onClick={() => {
                    const store = loadStats()
                    const users = Object.keys(store.users)
                    if (!users.length) return
                    const allSelected = users.every((u) => adminSelectedUsers[u])
                    const next = users.reduce<Record<string, boolean>>((acc, u) => {
                      acc[u] = !allSelected
                      return acc
                    }, {})
                    setAdminSelectedUsers(next)
                  }}
                >
                  Выбрать все
                </button>
                <button className="ghost" onClick={() => setAdminSelectedUsers({})}>
                  Снять выбор
                </button>
                <button className="primary" onClick={() => void deleteSelectedUsers()}>
                  Удалить выбранные
                </button>
              </div>
              <div className="adminUsers">
                {(() => {
                  const store = loadStats()
                  const users = Object.entries(store.users).sort((a, b) => b[1].testsCompleted - a[1].testsCompleted)
                  if (!users.length) return <div className="meta">Пока нет сохраненной статистики</div>

                  return users.map(([nick, st]) => (
                    <details key={nick} className="adminUser">
                      <summary>
                        <input
                          type="checkbox"
                          checked={!!adminSelectedUsers[nick]}
                          onChange={(e) => setAdminSelectedUsers((prev) => ({ ...prev, [nick]: e.target.checked }))}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Выбрать ${nick}`}
                        />
                        <span className="adminNick">{nick}</span>
                        <span className="adminKpi">
                          Тестов: <b>{st.testsCompleted}</b>
                        </span>
                        <span className="adminKpi">
                          Точность: <b>{percent(st.questionsCorrect, st.questionsAnswered)}</b>
                        </span>
                        <span className="adminKpi">
                          Время: <b>{formatDuration(st.timeMsTotal ?? 0)}</b>
                        </span>
                      </summary>
                      <div className="adminBody">
                        <div className="meta">
                          Вопросов отвечено: <b>{st.questionsAnswered}</b> · Правильно:{' '}
                          <b>{st.questionsCorrect}</b>
                          {' · '}
                          Среднее: <b>{st.questionsAnswered ? formatDuration(Math.round((st.timeMsTotal ?? 0) / st.questionsAnswered)) : '—'}</b> / вопрос
                        </div>
                        <div className="adminBlocks">
                          {Object.entries(st.blocks)
                            .sort((a, b) => b[1].answered - a[1].answered)
                            .map(([block, bs]) => (
                              <div key={block} className="adminBlock">
                                <span className="adminBlockName">{block}</span>
                                <span className="adminBlockKpi">
                                  {bs.correct}/{bs.answered} ({percent(bs.correct, bs.answered)}) · {formatDuration((st.timeMsByBlock ?? {})[block] ?? 0)}
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    </details>
                  ))
                })()}
              </div>
            </>
          )}
	          <div className="actions">
	            <button className="primary" onClick={() => setScreen('setup')}>
	              Назад
	            </button>
	            {adminAuthed && (
	              <button
	                className="ghost"
	                onClick={() => {
	                  adminLogout()
	                  setScreen('setup')
	                }}
	              >
	                Выйти
	              </button>
	            )}
	          </div>
	        </section>
	      )}

      <footer className="footer">
        <button type="button" className="linkLike" onClick={openAdmin}>
          Админ-статистика
        </button>
      </footer>
    </div>
  )
}

export default App
