#!/usr/bin/env node
// Fusion Ticket Watcher
// Überwacht das öffentliche Forum "Suche & Biete Festivaltickets" (f=82).
// Meldet zwei Dinge per Telegram:
//   1) Neue "Biete"-THREADS (Angebot schon im Titel) — selten.
//   2) Neue ANTWORTEN, in denen jemand ein Ticket anbietet
//      (z.B. "hätte noch eins abzugeben" in einem Suche-Thread) — der Hauptkanal.
// Read-only, höflich, kein Auto-Posten. Du antwortest selbst, eingeloggt.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ============== EINSTELLUNGEN (hier darfst du gern selbst schrauben) ==============
const BASE = "https://forum.fusion-festival.de";
const INDEX_URL = `${BASE}/viewforum.php?f=82`;
const STATE_FILE = new URL("./state.json", import.meta.url);

// --- Titel-Erkennung (für direkte "Biete"-Threads) ---
const OFFER_WORDS = [
  "biete", "verkauf", "abzugeben", "gebe ab", "zu vergeben", "zu verschenken",
  "tausche", "übrig", "ticket frei", " frei", "offering", "for sale", "to sell",
  "selling", "spare ticket", "available",
];
const SEEK_WORDS = [
  "such", "brauche", "benötig", "bräuchte", "nehme",
  "looking for", "searching", "in search", "wer hat", "wanted", "wtb",
];
const TICKET_WORDS = [
  "ticket", "karte", "fusionticket", "personenticket", "festivalticket",
  "bändchen", "wristband",
];

// --- Antwort-Erkennung (Stämme; per Wortgrenze gematcht, s. hasWord) ---
// Angebots-Vokabular ("ich gebe ab"):
const REPLY_OFFER_WORDS = [
  "biete", "bietet", "verkauf", "abzugeb", "gebe ab", "gebe dir", "gebe mein",
  "hätte noch", "hätte eins", "hab noch eins", "habe noch eins", "hab noch ein ticket",
  "noch eins frei", "ticket frei", "ticket übrig", "übrig", "zu vergeben", "zu verschenken",
  "kannst meins", "kannst es haben", "meins haben", "spare ticket", "you can have",
  "still have a ticket", "ticket available", "have one left",
];
// Suchrahmen ("wer HAT eins?") — überstimmt das Angebots-Vokabular:
const REPLY_SEEK_FRAMES = [
  "such", "gesuch", "brauch", "benötig", "bräuchte", "fehl",
  "falls jemand", "wer hat", "wer noch", "wer kann", "jemand noch ein",
  "kann mir jemand", "auf der suche", "wer verkauft mir", "looking for", "wanted",
];

// Telegram (im Live-Betrieb per Umgebungsvariablen gesetzt; lokal leer = nur Ausdruck):
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);

const MAX_DEEP_FETCHES = 12; // höchstens so viele Threads pro Lauf tief reinlesen (Höflichkeit)
const MAX_PINGS = 10;        // Drossel gegen Flut
const FETCH_DELAY_MS = 400;  // kleine Pause zwischen Thread-Abrufen

// KI-Check (optional): klassifiziert Antworten nach Sinn statt nach Stichwort.
// Ohne ANTHROPIC_API_KEY fällt der Wächter automatisch auf die Stichwort-Logik zurück.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-haiku-4-5-20251001";
// =================================================================================

const DEBUG = process.argv.includes("--debug");
const SCAN_ALL = process.argv.includes("--scan-all"); // Test: liest oberste Threads, pingt/speichert NICHT
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wortgrenze für Deutsch: ä/ö/ü/ß zählen als Buchstaben. Match nur am Wortanfang,
// damit "anbietet" NICHT als "biete" zählt, aber Beugungen (biete/bietet) schon.
const LETTER = "a-zäöüß";
function hasWord(text, stems) {
  for (const w of stems) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^${LETTER}])${esc}`, "i").test(text)) return true;
  }
  return false;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .trim();
}

// Beitragstext säubern: Zitate raus, Emoji-Bilder zu ihrem Alt-Text, restliche Tags weg.
function cleanPostText(s) {
  s = s.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " [ZITAT] ");
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "$1");
  s = s.replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

// Übersichtsseite -> [{tid, title, lastPid, replies, sticky}]
function parseIndex(html) {
  const rows = [];
  const titleRe = /<a href="\.\/viewtopic\.php\?[^"]*?t=(\d+)[^"]*"[^>]*class="topictitle[^"]*"[^>]*>([^<]+)<\/a>/g;
  const matches = [...html.matchAll(titleRe)];
  for (let n = 0; n < matches.length; n++) {
    const m = matches[n];
    const start = m.index + m[0].length;
    const end = n + 1 < matches.length ? matches[n + 1].index : html.length;
    const slice = html.slice(start, end);
    const pre = html.slice(Math.max(0, m.index - 220), m.index); // Kontext vor dem Titel
    const pm = slice.match(/viewtopic\.php\?[^"]*?p=(\d+)[^"]*#p\d+/); // "Gehe zum letzten Beitrag"
    const rm = slice.match(/Antworten:\s*<strong>(\d+)<\/strong>/);
    rows.push({
      tid: m[1],
      title: decodeEntities(m[2]),
      lastPid: pm ? pm[1] : null,
      replies: rm ? parseInt(rm[1], 10) : 0,
      sticky: /announce|ankündigung|global/i.test(pre), // Mod-Ankündigungen markieren
    });
  }
  return rows;
}

// Thread-Seite -> [{pid, author, text}]
function extractPosts(html) {
  const posts = [];
  const parts = html.split(/id="p(\d+)"\s+class="post/);
  for (let k = 1; k < parts.length; k += 2) {
    const pid = parts[k];
    const chunk = parts[k + 1] || "";
    const am = chunk.match(/class="username[^"]*">([^<]+)<\/a>/);
    const cm = chunk.match(/class="content">([\s\S]*?)<div class="back2top"/) || chunk.match(/class="content">([\s\S]{0,2000})/);
    posts.push({
      pid,
      author: am ? decodeEntities(am[1]) : "?",
      text: cm ? cleanPostText(cm[1]) : "",
    });
  }
  return posts;
}

function firstIndex(haystack, words) {
  let best = Infinity;
  for (const w of words) {
    const i = haystack.indexOf(w);
    if (i !== -1 && i < best) best = i;
  }
  return best;
}

// Titel: Angebot, wenn ein Biete-Wort VOR einem Suche-Wort steht und es um ein Ticket geht.
function isTitleOffer(title) {
  const t = title.toLowerCase();
  const offer = firstIndex(t, OFFER_WORDS);
  const seek = firstIndex(t, SEEK_WORDS);
  return offer !== Infinity && offer < seek && TICKET_WORDS.some((w) => t.includes(w));
}

// Antwort: enthält Angebots-Vokabular UND keinen Suchrahmen.
function isReplyOffer(text) {
  if (!text) return false;
  if (!hasWord(text, REPLY_OFFER_WORDS)) return false;
  if (hasWord(text, REPLY_SEEK_FRAMES)) return false;
  return true;
}

// KI-Urteil über eine Antwort. Liefert {offer, reason, src}. Ohne Key: Stichwort-Fallback.
async function judgeReply(title, text) {
  if (!ANTHROPIC_API_KEY) return { offer: isReplyOffer(text), reason: "Stichwort-Fallback", src: "stichwort" };
  const prompt =
`Forum "Suche & Biete Fusion-Festival-Tickets". Thread-Titel: "${title}".
Jemand schrieb diese Antwort:
"""${text.slice(0, 800)}"""

Bietet diese Person selbst ein Ticket an (abgeben/verkaufen/weitergeben)?
"false" bei: selbst suchen, Hochschieben ("up"), Nachfragen, Zitate, Sonstiges.
Antworte NUR mit JSON: {"offer": true oder false, "grund": "kurz"}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 80, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) {
      console.error("KI-Fehler:", r.status, (await r.text()).slice(0, 200));
      return { offer: isReplyOffer(text), reason: "KI-Fehler, Fallback", src: "stichwort" };
    }
    const data = await r.json();
    const out = (data.content?.[0]?.text || "").trim();
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      return { offer: j.offer === true, reason: j.grund || "", src: "ki" };
    }
    return { offer: isReplyOffer(text), reason: "KI unlesbar, Fallback", src: "stichwort" };
  } catch (e) {
    console.error("KI-Fehler:", e.message);
    return { offer: isReplyOffer(text), reason: "KI-Fehler, Fallback", src: "stichwort" };
  }
}

async function notify(item) {
  const text =
    item.type === "reply"
      ? `🎟️ Mögliches Ticket-Angebot in einer Antwort:\nThread: ${item.title}\nvon ${item.author}: "${item.snippet}"\n${item.url}\n→ eingeloggt im Thread antworten`
      : `🎟️ Neues Ticket-ANGEBOT (Thread):\n${item.title}\n${item.url}\n→ eingeloggt im Thread antworten`;
  if (!BOT_TOKEN || CHAT_IDS.length === 0) {
    console.log("[würde pingen]", text.replace(/\n/g, " | "));
    return;
  }
  for (const chat of CHAT_IDS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text }),
      });
      if (!r.ok) console.error("Telegram-Antwort:", r.status, await r.text());
    } catch (e) {
      console.error("Telegram-Fehler:", e.message);
    }
  }
}

async function main() {
  const indexHtml = await fetchText(INDEX_URL);
  const rows = parseIndex(indexHtml);

  if (DEBUG) {
    console.log(`\n--- DEBUG: ${rows.length} Threads auf Seite 1 ---`);
    for (const r of rows) {
      const flag = r.sticky ? "ANKÜNDIGUNG " : isTitleOffer(r.title) ? "TITEL-ANGEBOT" : "·············";
      console.log(`${flag}  t${r.tid} p${r.lastPid} (${r.replies} Antw.)  ${r.title}`);
    }
    console.log("---\n");
  }

  // --- Testmodus: oberste Threads reinlesen, nichts senden, nichts speichern ---
  if (SCAN_ALL) {
    console.log(`\n--- SCAN-ALL: lese die obersten Threads (nur Anzeige) ---\n`);
    for (const r of rows.slice(0, 9)) {
      if (r.sticky) { console.log(`(übersprungen, Ankündigung) ${r.title}`); continue; }
      if (!r.lastPid) continue;
      try {
        const posts = extractPosts(await fetchText(`${BASE}/viewtopic.php?p=${r.lastPid}`));
        console.log(`Thread "${r.title}" (${r.replies} Antworten):`);
        for (const p of posts) {
          if (p.text.length < 12) {
            console.log(`   ··          p${p.pid} von ${p.author}: ${p.text || "(kein Text)"}`);
            continue;
          }
          const v = await judgeReply(r.title, p.text);
          console.log(`   ${v.offer ? "✅ ANGEBOT " : "··         "}[${v.src}] p${p.pid} von ${p.author}: ${p.text.slice(0, 95)}  ${v.reason ? "→ " + v.reason : ""}`);
        }
        await sleep(FETCH_DELAY_MS);
      } catch (e) {
        console.error(`   Thread ${r.tid} nicht lesbar:`, e.message);
      }
    }
    return;
  }

  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const notified = new Set(state.notified || []);
  const lastPost = state.lastPost || {};
  const seeded = state.seeded === true;
  let changed = false;
  const queue = [];

  // 1) Titel-Angebote (direkte Biete-Threads; Ankündigungen überspringen)
  for (const r of rows) {
    if (r.sticky) continue;
    if (isTitleOffer(r.title) && !notified.has("t:" + r.tid)) {
      queue.push({ type: "title", tid: r.tid, title: r.title, url: `${BASE}/viewtopic.php?t=${r.tid}` });
    }
  }

  // 2) Neue Antworten
  if (!seeded) {
    for (const r of rows) if (r.lastPid) lastPost[r.tid] = r.lastPid;
    state.seeded = true;
    changed = true;
    console.log("Erster Lauf: Stand geimpft (keine alten Beiträge gemeldet). Ab dem nächsten Lauf zählt jede neue Antwort.");
  } else {
    const changedRows = rows.filter((r) => !r.sticky && r.lastPid && lastPost[r.tid] !== r.lastPid);
    let budget = MAX_DEEP_FETCHES;
    for (const r of changedRows) {
      if (budget <= 0) {
        console.log(`Hinweis: ${changedRows.length - MAX_DEEP_FETCHES} geänderte Threads kommen erst nächste Runde dran.`);
        break;
      }
      budget--;
      try {
        const prev = lastPost[r.tid];
        const posts = extractPosts(await fetchText(`${BASE}/viewtopic.php?p=${r.lastPid}`));
        for (const p of posts) {
          if (prev && Number(p.pid) <= Number(prev)) continue; // schon bekannt
          if (notified.has("p:" + p.pid)) continue;
          if (p.text.length < 12) continue; // Bumps/Emojis überspringen, kein KI-Aufruf nötig
          const verdict = await judgeReply(r.title, p.text);
          if (verdict.offer) {
            queue.push({
              type: "reply", tid: r.tid, title: r.title, pid: p.pid,
              author: p.author, snippet: p.text.slice(0, 200),
              url: `${BASE}/viewtopic.php?p=${p.pid}#p${p.pid}`,
            });
          }
        }
        lastPost[r.tid] = r.lastPid;
        changed = true;
        await sleep(FETCH_DELAY_MS);
      } catch (e) {
        console.error(`Thread ${r.tid} nicht lesbar:`, e.message);
      }
    }
  }

  // 3) Senden (gedrosselt)
  let sent = 0;
  for (const item of queue) {
    if (sent >= MAX_PINGS) {
      console.log(`Drossel: ${queue.length - MAX_PINGS} weitere Treffer diesmal nicht gesendet.`);
      break;
    }
    await notify(item);
    notified.add(item.type === "reply" ? "p:" + item.pid : "t:" + item.tid);
    sent++;
    changed = true;
  }

  if (changed) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ seeded: true, lastPost, notified: [...notified], updated: new Date().toISOString() }, null, 2),
    );
  }
  console.log(`Threads: ${rows.length} | Treffer gemeldet: ${sent} (${queue.length} gefunden)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
