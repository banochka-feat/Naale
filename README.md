# Naale — форма заявок на выезд

Человек открывает сайт, пишет имя, куда/к кому едет и даты «с» и «по».
Заявка приходит вам сообщением в Telegram.

```
Сайт (GitHub Pages)  →  Cloudflare Worker (хранит токен)  →  Telegram-бот  →  вам
```

Токен бота хранится только в Cloudflare, на сайте его нет — украсть его через сайт нельзя.

## Настройка (один раз, ~15 минут)

### 1. Создайте бота
1. В Telegram откройте **@BotFather** → `/newbot` → придумайте имя.
2. Скопируйте **токен** (вида `123456789:AA...`).
3. Найдите своего бота и нажмите **Start** (иначе он не сможет вам писать).

### 2. Узнайте свой chat id
Напишите боту **@userinfobot** — он ответит вашим `Id` (число). Это и есть chat id.
(Чтобы заявки шли в группу: добавьте бота в группу, а id группы узнайте через @getidsbot — он начинается с `-`.)

### 3. Разверните Worker на Cloudflare (бесплатно)
1. Зарегистрируйтесь на <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Create Worker**, назовите, например, `naale-form` → **Deploy**.
3. **Edit code** → удалите всё и вставьте содержимое файла [`worker/worker.js`](worker/worker.js) → **Deploy**.
4. **Settings → Variables and Secrets → Add**:
   - `TELEGRAM_TOKEN` — тип **Secret**, значение — токен из шага 1;
   - `TELEGRAM_CHAT_ID` — значение из шага 2;
   - (по желанию) `ALLOWED_ORIGIN` — `https://banochka-feat.github.io`, чтобы форму можно было отправлять только с вашего сайта.
5. Скопируйте адрес воркера (вида `https://naale-form.<логин>.workers.dev`).

### 4. Впишите адрес в сайт
В файле [`config.js`](config.js):
```js
window.FORM_ENDPOINT = "https://naale-form.<логин>.workers.dev";
```

### 5. Включите GitHub Pages
1. Влейте изменения в ветку `main`.
2. В репозитории: **Settings → Pages → Source: GitHub Actions**.
3. После деплоя сайт будет по адресу `https://banochka-feat.github.io/Naale/`.

## Проверка
Откройте сайт, отправьте тестовую заявку — через секунду она придёт в Telegram.

## Бот: одобрение заявок и команды

Каждая заявка с сайта приходит в Telegram с кнопками **«✅ Добавить» / «❌ Отклонить»**.
В список попадают только одобренные. Решение можно поменять кнопкой под сообщением.

| Команда | Что делает |
|---|---|
| `/list` | одобренные заявки списком и файлом `spisok.csv` (Excel / Google Таблицы) |
| `/add Имя; Куда; 01.12.2026; 07.12.2026; Комментарий` | добавить заявку вручную (комментарий и год можно не писать) |
| `/del 2` | убрать заявку №2 из списка (номера — как в `/list`) |
| `/clear` → `/clear_yes` | прислать итоговую таблицу и очистить список |

Бот отвечает только в вашем чате (`TELEGRAM_CHAT_ID`).

Настройка:
1. Cloudflare → **Storage & Databases → KV** → **Create** → имя `naale-trips`.
2. Worker → **Settings → Bindings** → **Add** → **KV namespace**: имя переменной `DB`, хранилище `naale-trips` → Deploy.
3. Замените код Worker на [`worker/worker.js`](worker/worker.js) → Deploy.
4. Worker → **Settings → Triggers → Cron Triggers** → расписание `* * * * *` (каждую минуту).
5. Один раз откройте `https://naale-form.mixailzhdanov375.workers.dev/setup` — должно ответить «Готово!».
   Это отключает webhook: команды и нажатия кнопок Worker забирает сам по Cron-триггеру.
