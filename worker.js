// ===== 設定値: 環境に合わせて書き換えてください =====
const LOG_DB_ID     = "3a7f58a616bd8078bb24e97794a9c7f9";
const ACTION_DB_ID  = "3a6f58a616bd80af98a9d9c7d4fa54ac";
const CABINET_DB_ID = "3a6f58a616bd802e848cc92c5dcf4177";
const ALLOWED_ORIGIN = "*"; // 個人利用なら*で可。絞りたい場合はPagesのURLに変更

// NOTION_TOKEN は Cloudflare の「変数とシークレット」に登録した env.NOTION_TOKEN を使う

const TITLE_MAP = {
  sleep:  "Sleep Time",
  break:  "Break Time",
  wakeup: "Break Time",
};

// LogDB/ActionDB/CabinetDBそれぞれのタイトルプロパティ名(実際の名前と違えば要修正)
const LOG_TITLE_PROP     = "Name";
const CABINET_TITLE_PROP = "Name";
const CABINET_TYPE_PROP  = "Type";
const CAPTURE_TYPE_VALUE = "📝｜Capture"; // 実際の選択肢と違う場合は要修正
const JOURNAL_TYPE_VALUE = "📖｜Journal";

function notionHeaders(env) {
  return {
    "Authorization": `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

// ---------- LogDB/ActionDBの操作(Sleep/Break/Wakeup共通) ----------
async function queryInProgress(env, dbId) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: { property: "Status", select: { equals: "▶️｜In Progress" } },
    }),
  });
  const data = await res.json();
  return data.results ?? [];
}

async function closeLogEntry(env, pageId, nowIso) {
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(env),
    body: JSON.stringify({
      properties: {
        "Status": { select: { name: "✅｜Done" } },
        "End Date": { date: { start: nowIso } },
      },
    }),
  });
}

async function holdActionEntry(env, pageId) {
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(env),
    body: JSON.stringify({
      properties: { "Status": { select: { name: "⏸️｜On Hold" } } },
    }),
  });
}

async function createLogEntry(env, title, nowIso) {
  await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      parent: { database_id: LOG_DB_ID },
      properties: {
        [LOG_TITLE_PROP]: { title: [{ text: { content: title } }] },
        "Status": { select: { name: "▶️｜In Progress" } },
        "Start Date": { date: { start: nowIso } },
      },
    }),
  });
}

async function handleAction(env, action) {
  const nowIso = new Date().toISOString();
  const title = TITLE_MAP[action];
  if (!title) throw new Error("unknown action");

  const runningLogs = await queryInProgress(env, LOG_DB_ID);
  for (const page of runningLogs) await closeLogEntry(env, page.id, nowIso);

  const runningActions = await queryInProgress(env, ACTION_DB_ID);
  for (const page of runningActions) await holdActionEntry(env, page.id);

  await createLogEntry(env, title, nowIso);
}

async function getLatestStatus(env) {
  const res = await fetch(`https://api.notion.com/v1/databases/${LOG_DB_ID}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1,
    }),
  });
  const data = await res.json();
  const page = data.results?.[0];
  const title = page?.properties?.[LOG_TITLE_PROP]?.title?.[0]?.plain_text ?? "";
  return title;
}

// ---------- Journal自動検索(CabinetDB) ----------
function jstDayRange(offsetDays) {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jstNow.setUTCDate(jstNow.getUTCDate() + offsetDays);
  const y = jstNow.getUTCFullYear(), m = jstNow.getUTCMonth(), d = jstNow.getUTCDate();
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const end   = new Date(Date.UTC(y, m, d + 1, 0, 0, 0) - 9 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function findJournalUrl(env, dayOffset) {
  const { start, end } = jstDayRange(dayOffset);
  const res = await fetch(`https://api.notion.com/v1/databases/${CABINET_DB_ID}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: {
        and: [
          { property: CABINET_TYPE_PROP, select: { equals: JOURNAL_TYPE_VALUE } },
          { timestamp: "created_time", created_time: { on_or_after: start } },
          { timestamp: "created_time", created_time: { before: end } },
        ],
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1,
    }),
  });
  const data = await res.json();
  return data.results?.[0]?.url ?? null;
}

// ---------- キャプチャ(CabinetDBにクイックメモ) ----------
async function createCaptureEntry(env, text) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      parent: { database_id: CABINET_DB_ID },
      properties: {
        [CABINET_TITLE_PROP]: { title: [{ text: { content: text.slice(0, 200) } }] },
        [CABINET_TYPE_PROP]: { select: { name: CAPTURE_TYPE_VALUE } },
      },
    }),
  });
  const data = await res.json();
  return data.url ?? null;
}

// ---------- ルーティング ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers });

    // このWorkerは /log /status /journal /capture の時だけ呼ばれる想定
    // (wrangler.jsoncのrun_worker_firstで絞っているため、それ以外はここに来ない)

    try {
      if (url.pathname === "/log" && request.method === "POST") {
        const { action } = await request.json();
        await handleAction(env, action);
        return new Response(JSON.stringify({ ok: true, action }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/status" && request.method === "GET") {
        const title = await getLatestStatus(env);
        return new Response(JSON.stringify({ title }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/journal" && request.method === "GET") {
        let journalUrl = await findJournalUrl(env, 0);
        if (!journalUrl) journalUrl = await findJournalUrl(env, -1);
        return new Response(JSON.stringify({ url: journalUrl }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/capture" && request.method === "POST") {
        const { text } = await request.json();
        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: "empty text" }), {
            status: 400,
            headers: { ...headers, "Content-Type": "application/json" },
          });
        }
        const pageUrl = await createCaptureEntry(env, text.trim());
        return new Response(JSON.stringify({ ok: true, url: pageUrl }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
