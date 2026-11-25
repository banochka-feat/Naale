// Cloudflare Worker: принимает заявки с сайта, сохраняет их и пересылает в Telegram.
// По команде /list бот присылает все заявки списком и файлом для Excel.
//
// Настройки Worker:
//   TELEGRAM_TOKEN   — секрет, токен бота от @BotFather
//   TELEGRAM_CHAT_ID — ваш Id (куда слать заявки)
//   ALLOWED_ORIGIN   — (необязательно) https://banochka-feat.github.io
//   DB               — привязка KV-хранилища (Привязки → KV namespace, имя DB)

const LIMITS = { name: 100, destination: 200, comment: 500 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

async function loadAll(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "trip:", cursor });
    const values = await Promise.all(page.keys.map((k) => env.DB.get(k.name, "json")));
    for (const v of values) if (v) items.push(v);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  items.sort((a, b) => a.created - b.created);
  return items;
}

function toCsv(items) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["№", "Имя", "Куда / к кому", "С", "По", "Комментарий", "Отправлено"]];
  items.forEach((t, i) => rows.push([i + 1, t.name, t.destination, formatDate(t.from), formatDate(t.to), t.comment, formatStamp(t.created)]));
  // BOM + точка с запятой — чтобы русский Excel открыл файл правильно
  return "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
}

async function sendList(env) {
  if (!env.DB) {
    return tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: "Хранилище не подключено: добавьте привязку KV с именем DB." });
  }
  const items = await loadAll(env);
  if (!items.length) {
    return tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: "Заявок пока нет." });
  }

  // Текстовый список, разбитый на сообщения до ~4000 символов
  const lines = items.map((t, i) =>
    `${i + 1}. <b>${escapeHtml(t.name)}</b> — ${escapeHtml(t.destination)}, ${formatDate(t.from)}–${formatDate(t.to)}` +
    (t.comment ? `\n    <i>${escapeHtml(t.comment)}</i>` : ""));
  const chunks = [];
  let cur = `📋 <b>Все заявки (${items.length})</b>\n\n`;
  for (const line of lines) {
    if (cur.length + line.length > 3900) { chunks.push(cur); cur = ""; }
    cur += line + "\n";
  }
  chunks.push(cur);
  for (const text of chunks) {
    await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" });
  }

  // Файл для Excel / Google Таблиц
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", "Таблица заявок (открывается в Excel / Google Таблицах)");
  form.append("document", new Blob([toCsv(items)], { type: "text/csv" }), "zayavki.csv");
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: "POST", body: form });
}

async function clearAll(env) {
  let cursor, count = 0;
  do {
    const page = await env.DB.list({ prefix: "trip:", cursor });
    await Promise.all(page.keys.map((k) => env.DB.delete(k.name)));
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

// Сброс: сначала присылаем итоговую таблицу (чтобы ничего не потерять), потом очищаем.
async function resetList(env) {
  const chat = env.TELEGRAM_CHAT_ID;
  if (!env.DB) return tg(env, "sendMessage", { chat_id: chat, text: "Хранилище не подключено." });
  const items = await loadAll(env);
  if (!items.length) return tg(env, "sendMessage", { chat_id: chat, text: "Список и так пустой." });
  const form = new FormData();
  form.append("chat_id", chat);
  form.append("caption", `Итоговая таблица перед сбросом. Всего заявок: ${items.length}`);
  form.append("document", new Blob([toCsv(items)], { type: "text/csv" }), "zayavki-arhiv.csv");
  const sent = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: "POST", body: form });
  if (!sent.ok) return tg(env, "sendMessage", { chat_id: chat, text: "Не удалось отправить архив, список НЕ очищен. Попробуйте ещё раз." });
  await clearAll(env);
  return tg(env, "sendMessage", { chat_id: chat, text: "🧹 Список очищен. Новые заявки начнут новый список." });
}

async function handleUpdate(update, env) {
  const msg = update && update.message;
  // Отвечаем только вам; ответ всегда уходит в ваш чат, чужим ничего не отправляется
  if (!msg || String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  const text = (msg.text || "").trim();
  if (/^\/(list|table|spisok)\b/.test(text)) {
    await sendList(env);
  } else if (/^\/clear_yes\b/.test(text)) {
    await resetList(env);
  } else if (/^\/(clear|reset|sbros)\b/.test(text)) {
    await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: "Сбросить список заявок?\nПеред очисткой я пришлю итоговую таблицу со всеми заявками.\n\nПодтвердите: /clear_yes" });
  } else if (/^\/(start|help)\b/.test(text)) {
    await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: "Новые заявки приходят сюда автоматически.\n/list — все заявки списком и таблицей\n/clear — сбросить список (начать заново)" });
  }
}

async function handleTelegram(request, env) {
  try { await handleUpdate(await request.json(), env); } catch {}
  return new Response("ok");
}

// Забираем команды у Telegram сами (getUpdates). Запускается Cron-триггером раз в минуту
// и ~50 секунд ждёт новые сообщения, поэтому бот отвечает почти сразу.
async function pollTelegram(env) {
  if (!env.DB) return;
  const until = Date.now() + 50000;
  while (Date.now() < until) {
    const offset = Number(await env.DB.get("tg_offset")) || 0;
    const wait = Math.max(1, Math.min(25, Math.floor((until - Date.now()) / 1000)));
    const res = await tg(env, "getUpdates", { offset, timeout: wait, allowed_updates: ["message"] });
    if (!res.ok) return; // например, 409 — уже работает другой запуск
    const data = await res.json();
    for (const update of data.result || []) {
      await env.DB.put("tg_offset", String(update.update_id + 1));
      try { await handleUpdate(update, env); } catch {}
    }
  }
}

// Открыть один раз в браузере: /setup — отключает webhook (команды забирает сам Worker)
// и добавляет /list в меню бота.
async function handleSetup(env) {
  const del = await (await tg(env, "deleteWebhook", {})).json();
  await tg(env, "setMyCommands", { commands: [{ command: "list", description: "Все заявки списком и таблицей" }, { command: "clear", description: "Сбросить список (начать заново)" }] });
  const ok = del.ok === true;
  const text = ok
    ? "Готово! Бот подключён. Напишите ему /list (ответ придёт в течение минуты)."
    : `Ошибка Telegram: ${del.description || "неизвестно"}`;
  return new Response(text, { status: ok ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

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

  const created = Date.now();
  if (env.DB) {
    const key = `trip:${created}-${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.put(key, JSON.stringify({ name, destination, from, to, comment, created }));
  }

  let text = `🧳 <b>Новая заявка на выезд</b>\n\n` +
    `<b>Имя:</b> ${escapeHtml(name)}\n` +
    `<b>Куда / к кому:</b> ${escapeHtml(destination)}\n` +
    `<b>Даты:</b> ${formatDate(from)} — ${formatDate(to)}`;
  if (comment) text += `\n<b>Комментарий:</b> ${escapeHtml(comment)}`;

  const res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" });
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
