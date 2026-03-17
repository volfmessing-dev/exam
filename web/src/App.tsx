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

const STATS_KEY_V1 = 'gosi_stats_v1'
const STATS_KEY_V2 = 'gosi_stats_v2'
const RUN_KEY_V1 = 'gosi_run_v1'
const NICKNAME_KEY = 'gosi_nickname'
const ADMIN_PASSWORD_KEY = 'gosi_admin_password'

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

function getAdminPassword(): string {
  return import.meta.env.VITE_ADMIN_PASSWORD || localStorage.getItem(ADMIN_PASSWORD_KEY) || ''
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

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const aa = [...a].sort((x, y) => x - y)
  const bb = [...b].sort((x, y) => x - y)
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false
  }
  return true
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
  runBlocks: Record<string, BlockStat>
  timeCommittedMs: number
  blockTimeCommittedMs: Record<string, number>
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

  const [quizSourceIndices, setQuizSourceIndices] = useState<number[]>([])
  const [quiz, setQuiz] = useState<Question[]>([])
  const [queue, setQueue] = useState<number[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [reveal, setReveal] = useState<'none' | 'checked'>('none')
  const [runBlocks, setRunBlocks] = useState<Record<string, BlockStat>>({})

  const [answered, setAnswered] = useState<number>(0)
  const [correct, setCorrect] = useState<number>(0)
  const [lastWasCorrect, setLastWasCorrect] = useState<boolean | null>(null)

  const questionStartedAtRef = useRef<number | null>(null)
  const timeCommittedMsRef = useRef<number>(0)
  const blockTimeCommittedMsRef = useRef<Record<string, number>>({})

  const [timerNow, setTimerNow] = useState<number>(() => Date.now())
  const [questionStartedAt, setQuestionStartedAt] = useState<number | null>(null)
  const [timeCommittedMs, setTimeCommittedMs] = useState<number>(0)
  const [blockTimeCommittedMs, setBlockTimeCommittedMs] = useState<Record<string, number>>({})

  const current = queue.length ? quiz[queue[0]!] : undefined

  useEffect(() => {
    localStorage.setItem(NICKNAME_KEY, nickname)
  }, [nickname])

  useEffect(() => {
    const snapshot = safeJsonParse<RunState>(sessionStorage.getItem(RUN_KEY_V1))
    if (!snapshot || snapshot.version !== 1 || snapshot.screen !== 'quiz') return

    if (!Array.isArray(snapshot.quizSourceIndices) || snapshot.quizSourceIndices.length === 0) return
    if (!Array.isArray(snapshot.queue) || snapshot.queue.length === 0) return
    if (!snapshot.quizSourceIndices.every((i) => Number.isInteger(i) && i >= 0 && i < data.questions.length)) return
    if (!snapshot.queue.every((q) => Number.isInteger(q) && q >= 0 && q < snapshot.quizSourceIndices.length)) return

    const now = Date.now()
    const restoredQuiz = snapshot.quizSourceIndices.map((i) => data.questions[i]!)

    setDiscipline(snapshot.discipline)
    setShuffle(snapshot.shuffle)
    setActiveNickname(snapshot.activeNickname)
    setQuizSourceIndices(snapshot.quizSourceIndices)
    setQuiz(restoredQuiz)
    setQueue(snapshot.queue)
    setPicked(snapshot.picked ?? [])
    setReveal(snapshot.reveal ?? 'none')
    setAnswered(snapshot.answered ?? 0)
    setCorrect(snapshot.correct ?? 0)
    setLastWasCorrect(snapshot.lastWasCorrect ?? null)
    setRunBlocks(snapshot.runBlocks ?? {})

    questionStartedAtRef.current = now
    timeCommittedMsRef.current = snapshot.timeCommittedMs ?? 0
    blockTimeCommittedMsRef.current = snapshot.blockTimeCommittedMs ?? {}
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
      runBlocks,
      timeCommittedMs: timeTotal,
      blockTimeCommittedMs: byBlock,
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

  useEffect(() => {
    if (screen !== 'quiz') return
    persistRunSnapshot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, discipline, shuffle, activeNickname, quizSourceIndices, queue, picked, reveal, answered, correct, lastWasCorrect, runBlocks])

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
    if (screen !== 'quiz') return
    const id = window.setInterval(() => persistRunSnapshot(), 5000)
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

  const start = () => {
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
    setTimerNow(now)
    setQuestionStartedAt(now)
    setTimeCommittedMs(0)
    setBlockTimeCommittedMs({})

    setQuizSourceIndices(nextIndices)
    setQuiz(next)
    setQueue(next.map((_, i) => i))
    setPicked([])
    setReveal('none')
    setAnswered(0)
    setCorrect(0)
    setRunBlocks({})
    setLastWasCorrect(null)
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
    const ok = sameSet(picked, current.answer)
    setReveal('checked')
    setLastWasCorrect(ok)
  }

  const skip = () => {
    if (reveal !== 'none') return
    commitCurrentQuestionTime()
    setQueue((prev) => {
      if (prev.length <= 1) return prev
      return [...prev.slice(1), prev[0]!]
    })
    setPicked([])
    setLastWasCorrect(null)
  }

  const next = () => {
    if (!current) return
    if (reveal === 'none') return

    commitCurrentQuestionTime()

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
      clearRunSnapshot()
      const nick = activeNickname
      if (nick) {
        const store = loadStats()
        const user = store.users[nick] ?? {
          testsCompleted: 0,
          questionsAnswered: 0,
          questionsCorrect: 0,
          blocks: {},
          timeMsTotal: 0,
          timeMsByBlock: {},
          updatedAt: Date.now(),
        }

        const nextUser: UserStats = {
          ...user,
          testsCompleted: user.testsCompleted + 1,
          questionsAnswered: user.questionsAnswered + answeredNext,
          questionsCorrect: user.questionsCorrect + correctNext,
          blocks: Object.keys(runBlocksNext).reduce<Record<string, BlockStat>>((acc, block) => {
            const prev = user.blocks[block] ?? { answered: 0, correct: 0 }
            const add = runBlocksNext[block]!
            acc[block] = {
              answered: prev.answered + add.answered,
              correct: prev.correct + add.correct,
            }
            return acc
          }, { ...user.blocks }),
          timeMsTotal: (user.timeMsTotal ?? 0) + timeCommittedMsRef.current,
          timeMsByBlock: Object.keys(blockTimeCommittedMsRef.current).reduce<Record<string, number>>((acc, block) => {
            acc[block] = (acc[block] ?? 0) + (blockTimeCommittedMsRef.current[block] ?? 0)
            return acc
          }, { ...(user.timeMsByBlock ?? {}) }),
          updatedAt: Date.now(),
        }

        saveStats({ ...store, users: { ...store.users, [nick]: nextUser } })
      }
      setQueue([])
      setScreen('result')
      return
    }

    setQueue(nextQueue)
    setPicked([])
    setReveal('none')
    setLastWasCorrect(null)
  }

  const reset = () => {
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
    setActiveNickname(null)

    questionStartedAtRef.current = null
    timeCommittedMsRef.current = 0
    blockTimeCommittedMsRef.current = {}
    setQuestionStartedAt(null)
    setTimeCommittedMs(0)
    setBlockTimeCommittedMs({})
  }

  const openAdmin = () => {
    const configured = getAdminPassword()
    if (!configured) {
      const nextPw = window.prompt('Админ-пароль не настроен. Задайте новый (сохранится в этом браузере)')
      if (!nextPw) return
      localStorage.setItem(ADMIN_PASSWORD_KEY, nextPw)
      setAdminAuthed(true)
      setScreen('admin')
      return
    }

    const pw = window.prompt('Пароль администратора')
    if (pw === null) return
    if (pw !== configured) return void window.alert('Неверный пароль')

    setAdminAuthed(true)
    setScreen('admin')
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
            <button className="primary" onClick={start}>
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
          {current.multi && <div className="hint">Можно выбрать несколько вариантов</div>}

          <div className="options" role="group" aria-label="Варианты ответа">
            {current.options.map((opt, optionIndex) => {
              const isPicked = picked.includes(optionIndex)
              const isCorrect = current.answer.includes(optionIndex)
              const state = reveal === 'none' ? '' : isCorrect ? 'correct' : isPicked ? 'wrong' : ''
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
                  <div className={`verdict ${lastWasCorrect ? 'ok' : 'bad'}`}>
                    {lastWasCorrect ? 'Верно' : 'Неверно'}
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
            <button className="primary" onClick={start} disabled={quiz.length === 0}>
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
            <div className="meta">Доступ закрыт</div>
          ) : (
            <>
              <div className="adminUsers">
                {(() => {
                  const store = loadStats()
                  const users = Object.entries(store.users).sort((a, b) => b[1].testsCompleted - a[1].testsCompleted)
                  if (!users.length) return <div className="meta">Пока нет сохраненной статистики</div>

                  return users.map(([nick, st]) => (
                    <details key={nick} className="adminUser">
                      <summary>
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
            <button
              className="ghost"
              onClick={() => {
                setAdminAuthed(false)
                setScreen('setup')
              }}
            >
              Выйти
            </button>
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
