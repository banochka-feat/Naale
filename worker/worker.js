// Cloudflare Worker: принимает заявку с сайта и пересылает её в Telegram.
// Секреты задаются в настройках Worker (не в коде!):
//   TELEGRAM_TOKEN   — токен бота от @BotFather
//   TELEGRAM_CHAT_ID — ваш chat id (куда слать заявки)
// Необязательная переменная:
//   ALLOWED_ORIGIN   — адрес сайта, например https://banochka-feat.github.io
//                      (если не задан, принимаются запросы с любого сайта)

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
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (request.method !== "POST") return json({ error: "method" }, 405, env);

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: "bad json" }, 400, env);
    }

    // Ловушка для ботов: если скрытое поле заполнено — делаем вид, что всё ок.
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

    let text =
      `🧳 <b>Новая заявка на выезд</b>\n\n` +
      `<b>Имя:</b> ${escapeHtml(name)}\n` +
      `<b>Куда / к кому:</b> ${escapeHtml(destination)}\n` +
      `<b>Даты:</b> ${formatDate(from)} — ${formatDate(to)}`;
    if (comment) text += `\n<b>Комментарий:</b> ${escapeHtml(comment)}`;

    const tg = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });

    if (!tg.ok) return json({ error: "telegram" }, 502, env);
    return json({ ok: true }, 200, env);
  },
};
