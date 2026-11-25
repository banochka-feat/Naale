// Cloudflare Worker: принимает заявки с сайта, сохраняет их и присылает в Telegram на одобрение.
//
// Команды бота (отвечает только вам):
//   /list                 — одобренные заявки списком и файлом для Excel
//   /add Имя; Куда; С; По; Комментарий — добавить заявку вручную (сразу одобрена)
//   /del N                — убрать заявку №N из списка
//   /clear → /clear_yes   — прислать итоговую таблицу и очистить всё
// Под каждой новой заявкой кнопки «✅ Добавить» / «❌ Отклонить»; решение можно поменять.
//
// Настройки Worker:
//   TELEGRAM_TOKEN   — секрет, токен бота от @BotFather
//   TELEGRAM_CHAT_ID — ваш Id (куда слать заявки)
//   ALLOWED_ORIGIN   — (необязательно) https://banochka-feat.github.io
//   DB               — привязка KV-хранилища (Привязки → KV namespace, имя DB)
//   Cron-триггер     — «каждую минуту» (* * * * *): бот забирает команды и нажатия кнопок

const LIMITS = { name: 100, destination: 200, comment: 500 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPDATES = ["message", "callback_query"];

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...cors(env) },
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function formatDate(iso) { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; }
function formatStamp(ms) {
  const d = new Date(ms + 3 * 3600 * 1000); // время по Москве
  return d.toISOString().slice(0, 16).replace("T", " ");
}

async function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
function say(env, text, extra = {}) {
  return tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", ...extra });
}

// ---------- хранилище ----------

// Старые заявки без статуса считаем одобренными.
const isApproved = (t) => !t.status || t.status === "approved";

async function loadAll(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "trip:", cursor });
    const values = await Promise.all(page.keys.map(async (k) => {
      const v = await env.DB.get(k.name, "json");
      return v ? { ...v, key: k.name } : null;
    }));
    for (const v of values) if (v) items.push(v);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  items.sort((a, b) => a.created - b.created);
  return items;
}
const loadApproved = async (env) => (await loadAll(env)).filter(isApproved);

async function saveTrip(env, trip) {
  const key = `trip:${trip.created}-${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.put(key, JSON.stringify(trip));
  return key;
}
async function setStatus(env, key, status) {
  const trip = await env.DB.get(key, "json");
  if (!trip) return null;
  trip.status = status;
  await env.DB.put(key, JSON.stringify(trip));
  return trip;
}

// ---------- оформление ----------

function tripText(t, title) {
  let text = `${title}\n\n` +
    `<b>Имя:</b> ${escapeHtml(t.name)}\n` +
    `<b>Куда / к кому:</b> ${escapeHtml(t.destination)}\n` +
    `<b>Даты:</b> ${formatDate(t.from)} — ${formatDate(t.to)}`;
  if (t.comment) text += `\n<b>Комментарий:</b> ${escapeHtml(t.comment)}`;
  if (t.status === "approved") text += `\n\n✅ <b>В списке</b>`;
  if (t.status === "rejected") text += `\n\n❌ <b>Не в списке</b>`;
  return text;
}
function tripButtons(key, status) {
  const id = key.slice(5); // без "trip:"
  if (status === "approved") return { inline_keyboard: [[{ text: "❌ Убрать из списка", callback_data: `no:${id}` }]] };
  if (status === "rejected") return { inline_keyboard: [[{ text: "✅ Всё-таки добавить", callback_data: `ok:${id}` }]] };
  return { inline_keyboard: [[
    { text: "✅ Добавить", callback_data: `ok:${id}` },
    { text: "❌ Отклонить", callback_data: `no:${id}` },
  ]] };
}
const titleFor = (t) => (t.manual ? "✍️ <b>Заявка добавлена вручную</b>" : "🧳 <b>Заявка на выезд</b>");

function toCsv(items) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["№", "Имя", "Куда / к кому", "С", "По", "Комментарий", "Отправлено"]];
  items.forEach((t, i) => rows.push([i + 1, t.name, t.destination, formatDate(t.from), formatDate(t.to), t.comment, formatStamp(t.created)]));
  // BOM + точка с запятой — чтобы русский Excel открыл файл правильно
  return "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
}
function sendCsv(env, items, caption, filename) {
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("document", new Blob([toCsv(items)], { type: "text/csv" }), filename);
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: "POST", body: form });
}

// ---------- команды ----------

async function sendList(env) {
  const all = await loadAll(env);
  const items = all.filter(isApproved);
  const pending = all.filter((t) => t.status === "pending").length;
  const pendingNote = pending ? `\n\n⏳ Ждут решения: ${pending} (кнопки под заявками)` : "";
  if (!items.length) return say(env, `Список пока пуст.${pendingNote}`);

  const lines = items.map((t, i) =>
    `${i + 1}. <b>${escapeHtml(t.name)}</b> — ${escapeHtml(t.destination)}, ${formatDate(t.from)}–${formatDate(t.to)}` +
    (t.comment ? `\n    <i>${escapeHtml(t.comment)}</i>` : ""));
  const chunks = [];
  let cur = `📋 <b>Список (${items.length})</b>\n\n`;
  for (const line of lines) {
    if (cur.length + line.length > 3800) { chunks.push(cur); cur = ""; }
    cur += line + "\n";
  }
  cur += `\nУбрать кого-то: /del номер` + pendingNote;
  chunks.push(cur);
  for (const text of chunks) await say(env, text);
  return sendCsv(env, items, "Таблица (открывается в Excel / Google Таблицах)", "spisok.csv");
}

function parseDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  y = y ? (y.length === 2 ? "20" + y : y) : String(new Date().getUTCFullYear());
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const dt = new Date(iso + "T00:00:00Z");
  if (isNaN(dt) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

const ADD_HELP =
  "Чтобы добавить заявку вручную, напишите через точку с запятой:\n\n" +
  "<code>/add Имя; Куда или к кому; С; По; Комментарий</code>\n\n" +
  "Например:\n<code>/add Иван Петров; Казань, к брату; 01.12.2026; 07.12.2026</code>\n\n" +
  "Комментарий можно не писать. Год у дат тоже можно не писать.";

async function addManual(env, args) {
  const parts = args.split(/;|\n/).map((s) => s.trim());
  if (parts.length < 4 || !parts[0] || !parts[1]) return say(env, ADD_HELP);
  const [name, destination, fromRaw, toRaw, ...rest] = parts;
  const comment = rest.filter(Boolean).join("; ");
  const from = parseDate(fromRaw), to = parseDate(toRaw);
  if (!from || !to) return say(env, "Не понял даты. Пишите так: 01.12.2026\n\n" + ADD_HELP);
  if (to < from) return say(env, "Дата «по» раньше даты «с». Проверьте и отправьте ещё раз.");
  if (name.length > LIMITS.name || destination.length > LIMITS.destination || comment.length > LIMITS.comment) {
    return say(env, "Слишком длинный текст. Сократите и отправьте ещё раз.");
  }
  const trip = { name, destination, from, to, comment, created: Date.now(), manual: true, status: "approved" };
  const key = await saveTrip(env, trip);
  return say(env, tripText(trip, titleFor(trip)), { reply_markup: tripButtons(key, "approved") });
}

async function deleteByNumber(env, arg) {
  const n = parseInt(arg, 10);
  const items = await loadApproved(env);
  if (!n || n < 1 || n > items.length) {
    return say(env, items.length
      ? `Напишите номер из списка, например: <code>/del 2</code>\nСейчас в списке ${items.length}. Номера смотрите в /list`
      : "Список пуст, удалять нечего.");
  }
  const t = items[n - 1];
  await setStatus(env, t.key, "rejected");
  return say(env, `🗑 Убрал из списка: <b>${escapeHtml(t.name)}</b> — ${escapeHtml(t.destination)}, ${formatDate(t.from)}–${formatDate(t.to)}`,
    { reply_markup: tripButtons(t.key, "rejected") });
}

async function clearAll(env) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "trip:", cursor });
    await Promise.all(page.keys.map((k) => env.DB.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// Сброс: сначала присылаем итоговую таблицу (чтобы ничего не потерять), потом очищаем.
async function resetList(env) {
  const all = await loadAll(env);
  if (!all.length) return say(env, "Список и так пустой.");
  const items = all.filter(isApproved);
  if (items.length) {
    const sent = await sendCsv(env, items, `Итоговая таблица перед сбросом. Всего: ${items.length}`, "spisok-arhiv.csv");
    if (!sent.ok) return say(env, "Не удалось отправить архив, список НЕ очищен. Попробуйте ещё раз.");
  }
  await clearAll(env);
  return say(env, "🧹 Список очищен. Новые заявки начнут новый список.");
}

const HELP =
  "Новые заявки приходят сюда с кнопками «✅ Добавить» / «❌ Отклонить».\n\n" +
  "/list — список и таблица\n" +
  "/add — добавить заявку вручную\n" +
  "/del номер — убрать из списка\n" +
  "/clear — сбросить список (начать заново)";

async function handleMessage(msg, env) {
  if (String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  if (!env.DB) return say(env, "Хранилище не подключено: добавьте привязку KV с именем DB.");
  const text = (msg.text || "").trim();
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  if (!m) return;
  const [, cmd, args] = m;
  switch (cmd.toLowerCase()) {
    case "list": case "table": case "spisok": return sendList(env);
    case "add": return args ? addManual(env, args) : say(env, ADD_HELP);
    case "del": case "delete": return deleteByNumber(env, args);
    case "clear": case "reset": case "sbros":
      return say(env, "Сбросить список?\nПеред очисткой я пришлю итоговую таблицу.\n\nПодтвердите: /clear_yes");
    case "clear_yes": return resetList(env);
    case "start": case "help": return say(env, HELP);
  }
}

async function handleCallback(cq, env) {
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  if (String(cq.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer("Нет доступа");
  const m = String(cq.data || "").match(/^(ok|no):(.+)$/);
  if (!m || !env.DB) return answer("");
  const key = "trip:" + m[2];
  const where = { chat_id: cq.message.chat.id, message_id: cq.message.message_id };
  const trip = await setStatus(env, key, m[1] === "ok" ? "approved" : "rejected");
  if (!trip) {
    await tg(env, "editMessageReplyMarkup", { ...where, reply_markup: { inline_keyboard: [] } });
    return answer("Этой заявки уже нет (список сбрасывали)");
  }
  await tg(env, "editMessageText", {
    ...where, text: tripText(trip, titleFor(trip)), parse_mode: "HTML", reply_markup: tripButtons(key, trip.status),
  });
  return answer(trip.status === "approved" ? "Добавлено в список" : "Убрано из списка");
}

async function handleUpdate(update, env) {
  if (update?.message) return handleMessage(update.message, env);
  if (update?.callback_query) return handleCallback(update.callback_query, env);
}

async function handleTelegram(request, env) {
  try { await handleUpdate(await request.json(), env); } catch {}
  return new Response("ok");
}

// Забираем команды и нажатия кнопок у Telegram сами (getUpdates). Запускается Cron-триггером
// раз в минуту и ~50 секунд ждёт новые события, поэтому бот отвечает почти сразу.
async function pollTelegram(env) {
  if (!env.DB) return;
  const until = Date.now() + 50000;
  while (Date.now() < until) {
    const offset = Number(await env.DB.get("tg_offset")) || 0;
    const wait = Math.max(1, Math.min(25, Math.floor((until - Date.now()) / 1000)));
    const res = await tg(env, "getUpdates", { offset, timeout: wait, allowed_updates: UPDATES });
    if (!res.ok) return; // например, 409 — уже работает другой запуск
    const data = await res.json();
    for (const update of data.result || []) {
      await env.DB.put("tg_offset", String(update.update_id + 1));
      try { await handleUpdate(update, env); } catch {}
    }
  }
}

// Открыть один раз в браузере: /setup — отключает webhook (события забирает сам Worker
// по Cron-триггеру) и обновляет меню команд бота.
async function handleSetup(env) {
  const del = await (await tg(env, "deleteWebhook", {})).json();
  await tg(env, "setMyCommands", { commands: [
    { command: "list", description: "Список и таблица" },
    { command: "add", description: "Добавить заявку вручную" },
    { command: "del", description: "Убрать из списка по номеру" },
    { command: "clear", description: "Сбросить список (начать заново)" },
  ] });
  const ok = del.ok === true;
  const text = ok
    ? "Готово! Бот подключён. Напишите ему /list (ответ придёт в течение минуты)."
    : `Ошибка Telegram: ${del.description || "неизвестно"}`;
  return new Response(text, { status: ok ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// ---------- форма с сайта ----------

async function handleForm(request, env) {
  let data;
  try { data = await request.json(); } catch { return json({ error: "bad json" }, 400, env); }
  if (data.website) return json({ ok: true }, 200, env);

  const name = String(data.name || "").trim();
  const destination = String(data.destination || "").trim();
  const comment = String(data.comment || "").trim();
  const from = String(data.from || "");
  const to = String(data.to || "");
  if (!name || !destination || !DATE_RE.test(from) || !DATE_RE.test(to) || to < from ||
      name.length > LIMITS.name || destination.length > LIMITS.destination || comment.length > LIMITS.comment) {
    return json({ error: "invalid" }, 400, env);
  }

  const trip = { name, destination, from, to, comment, created: Date.now(), status: "pending" };
  let extra = {};
  if (env.DB) {
    const key = await saveTrip(env, trip);
    extra = { reply_markup: tripButtons(key, "pending") };
  }

  const res = await say(env, tripText(trip, "🧳 <b>Новая заявка на выезд</b>"), extra);
  if (!res.ok) return json({ error: "telegram" }, 502, env);
  return json({ ok: true }, 200, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (request.method === "GET" && url.pathname === "/setup") return handleSetup(env);
    if (request.method !== "POST") return json({ error: "method" }, 405, env);
    if (url.pathname === "/tg") return handleTelegram(request, env);
    return handleForm(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollTelegram(env));
  },
};
