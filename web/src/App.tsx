import './App.css'
import { useMemo, useState } from 'react'
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

  const [screen, setScreen] = useState<Screen>('setup')
  const [discipline, setDiscipline] = useState<string>('__all__')
  const [shuffle, setShuffle] = useState<boolean>(true)

  const [quiz, setQuiz] = useState<Question[]>([])
  const [idx, setIdx] = useState<number>(0)
  const [picked, setPicked] = useState<number[]>([])
  const [reveal, setReveal] = useState<'none' | 'checked' | 'shown'>('none')

  const [answered, setAnswered] = useState<number>(0)
  const [correct, setCorrect] = useState<number>(0)
  const [lastWasCorrect, setLastWasCorrect] = useState<boolean | null>(null)

  const current = quiz[idx]

  const start = () => {
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
    setLastWasCorrect(null)
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

    if (reveal === 'checked' && lastWasCorrect !== null) {
      setAnswered((x) => x + 1)
      if (lastWasCorrect) setCorrect((x) => x + 1)
    }

    const nextIdx = idx + 1
    if (nextIdx >= quiz.length) {
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
    setLastWasCorrect(null)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">Госы</div>
        <div className="sub">Тренажер тестовых вопросов</div>
      </header>

      {screen === 'setup' && (
        <section className="panel">
          <h1>Запуск</h1>
          <div className="formRow">
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
              Правильно: <b>{correct}</b> / {answered}
            </div>
          </div>

          <div className="discipline">{current.discipline}</div>
          <h2 className="question">{current.question}</h2>
          {current.multi && <div className="hint">Можно выбрать несколько вариантов</div>}

          <div className="options" role="group" aria-label="Варианты ответа">
            {current.options.map((opt, optionIndex) => {
              const isPicked = picked.includes(optionIndex)
              const isCorrect = current.answer.includes(optionIndex)
              const state =
                reveal !== 'none' && (isCorrect ? 'correct' : isPicked ? 'wrong' : 'idle')

              return (
                <button
                  key={optionIndex}
                  type="button"
                  className={`option ${state}`}
                  onClick={() => togglePick(optionIndex)}
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
              {correct} / {quiz.length}
            </div>
            <div className="small">
              Точность: {quiz.length ? Math.round((correct / quiz.length) * 100) : 0}%
            </div>
          </div>
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

      <footer className="footer">
        Данные: <code>госы.docx</code> (парсер: <code>scripts/parse_docx_questions.py</code>)
      </footer>
    </div>
  )
}

export default App
