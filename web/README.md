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

Админ-доступ настраивается на сервере (а не во фронтенде):

- `ADMIN_LOGIN` (по умолчанию `admin`)
- `ADMIN_PASSWORD` (по умолчанию `BeeIT@2026`)
