import './App.css'
import { useEffect, useMemo, useState } from 'react'
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

type UserStats = {
  testsCompleted: number
  questionsAnswered: number
  questionsCorrect: number
  blocks: Record<string, BlockStat>
  updatedAt: number
}

type StatsStore = {
  version: 1
  users: Record<string, UserStats>
}

const STATS_KEY = 'gosi_stats_v1'
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
  const parsed = safeJsonParse<StatsStore>(localStorage.getItem(STATS_KEY))
  if (parsed && parsed.version === 1 && parsed.users) return parsed
  return { version: 1, users: {} }
}

function saveStats(store: StatsStore): void {
  localStorage.setItem(STATS_KEY, JSON.stringify(store))
}

function getAdminPassword(): string {
  return (
    import.meta.env.VITE_ADMIN_PASSWORD ||
    localStorage.getItem(ADMIN_PASSWORD_KEY) ||
    'BeeIT@2026'
  )
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

  const [quiz, setQuiz] = useState<Question[]>([])
  const [idx, setIdx] = useState<number>(0)
  const [picked, setPicked] = useState<number[]>([])
  const [reveal, setReveal] = useState<'none' | 'checked' | 'shown'>('none')
  const [runBlocks, setRunBlocks] = useState<Record<string, BlockStat>>({})

  const [answered, setAnswered] = useState<number>(0)
  const [correct, setCorrect] = useState<number>(0)
  const [lastWasCorrect, setLastWasCorrect] = useState<boolean | null>(null)

  const current = quiz[idx]

  useEffect(() => {
    localStorage.setItem(NICKNAME_KEY, nickname)
  }, [nickname])

  const start = () => {
    const nick = nickname.trim()
    const filtered =
      discipline === '__all__'
        ? data.questions
        : data.questions.filter((q) => q.discipline === discipline)

    const next = [...filtered]
    if (shuffle) shuffleInPlace(next, Date.now())

    setQuiz(next)
    setIdx(0)
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

  const showAnswer = () => {
    if (!current) return
    setReveal('shown')
    setLastWasCorrect(null)
  }

  const next = () => {
    if (!current) return
    if (reveal === 'none') return

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

    const nextIdx = idx + 1
    if (nextIdx >= quiz.length) {
      const nick = activeNickname
      if (nick) {
        const store = loadStats()
        const user = store.users[nick] ?? {
          testsCompleted: 0,
          questionsAnswered: 0,
          questionsCorrect: 0,
          blocks: {},
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
          updatedAt: Date.now(),
        }

        saveStats({ ...store, users: { ...store.users, [nick]: nextUser } })
      }
      setScreen('result')
      return
    }

    setIdx(nextIdx)
    setPicked([])
    setReveal('none')
    setLastWasCorrect(null)
  }

  const reset = () => {
    setScreen('setup')
    setQuiz([])
    setIdx(0)
    setPicked([])
    setReveal('none')
    setAnswered(0)
    setCorrect(0)
    setRunBlocks({})
    setLastWasCorrect(null)
    setActiveNickname(null)
  }

  const openAdmin = () => {
    const pw = window.prompt('Пароль администратора')
    if (pw === null) return
    if (pw !== getAdminPassword()) {
      window.alert('Неверный пароль')
      return
    }
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
            <label>
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
            <label>
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
                Вопрос {idx + 1} из {quiz.length}
              </div>
              <div className="bar">
                <div
                  className="barFill"
                  style={{ width: `${((idx + 1) / quiz.length) * 100}%` }}
                />
              </div>
            </div>
            <div className="score">
              Правильно: <b>{correct}</b> / {answered || '—'}
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
                <button className="ghost" onClick={showAnswer}>
                  Показать ответ
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
                {reveal === 'shown' && <div className="verdict ok">Ответ показан</div>}
                <button className="primary" onClick={next}>
                  Дальше
                </button>
              </>
            )}
            <button className="ghost" onClick={reset}>
              Сброс
            </button>
          </div>
        </section>
      )}

      {screen === 'result' && (
        <section className="panel">
          <h1>Результат</h1>
          <div className="resultCard">
            <div className="big">
              {correct} / {answered || 0}
            </div>
            <div className="small">
              Точность: {answered ? Math.round((correct / answered) * 100) : 0}% · Вопросов: {quiz.length}
            </div>
          </div>
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
              <div className="meta">
                Пароль можно переопределить через <code>VITE_ADMIN_PASSWORD</code> или в браузере (ключ{' '}
                <code>{ADMIN_PASSWORD_KEY}</code>).
              </div>
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
                      </summary>
                      <div className="adminBody">
                        <div className="meta">
                          Вопросов отвечено: <b>{st.questionsAnswered}</b> · Правильно:{' '}
                          <b>{st.questionsCorrect}</b>
                        </div>
                        <div className="adminBlocks">
                          {Object.entries(st.blocks)
                            .sort((a, b) => b[1].answered - a[1].answered)
                            .map(([block, bs]) => (
                              <div key={block} className="adminBlock">
                                <span className="adminBlockName">{block}</span>
                                <span className="adminBlockKpi">
                                  {bs.correct}/{bs.answered} ({percent(bs.correct, bs.answered)})
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
