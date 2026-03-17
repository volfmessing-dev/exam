# Госы: тренажер

React-витрина для вопросов из `../госы.docx`.

## Данные

Парсер: `../scripts/parse_docx_questions.py`  
Выходной файл: `src/data/questions.json`

Обновить данные:

```bash
cd web
npm run parse:questions
```

## Запуск

```bash
cd web
npm install
npm run dev
```

## Админ-доступ

В проекте нет «секретного» админ-пароля (фронтенд не может хранить секреты).

Опции:

- Локально: скопировать `web/.env.example` → `web/.env` и задать `VITE_ADMIN_PASSWORD`.
- Или оставить пароль пустым — при первом входе в админку приложение предложит задать пароль и сохранит его в `localStorage`.
