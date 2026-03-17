# Госы: тренажер

Вопросы парсятся из `госы.docx`, веб-морда лежит в `web/`.

## Обновить вопросы

```bash
python3 scripts/parse_docx_questions.py
```

## Запуск (локально)

```bash
cd web
npm install
npm run dev
```

## Docker

Сборка и запуск через compose:

```bash
docker compose up --build
```

Открыть: `http://localhost:8080/`

## Публикация

В репозитории есть workflow’ы:

- GitHub Pages: `.github/workflows/pages.yml`
- Docker image в GHCR: `.github/workflows/ghcr.yml`

