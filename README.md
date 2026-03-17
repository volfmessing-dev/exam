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

### Статистика (персистентно)

Статистика теперь хранится в файле внутри docker volume `gosy-stats` (монтируется в `/data`), поэтому не сбрасывается при пересборке/пересоздании контейнера.

Админ-доступ (страница «Админ-статистика») задается на сервере через переменные окружения `ADMIN_LOGIN` (по умолчанию `admin`) и `ADMIN_PASSWORD`.

## Публикация

В репозитории есть workflow’ы:

- GitHub Pages: `.github/workflows/pages.yml`
- Docker image в GHCR: `.github/workflows/ghcr.yml`

GitHub Pages публикуется через ветку `gh-pages` (workflow пушит сборку в эту ветку).

Один раз в репозитории включить: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: gh-pages /(root)**.
