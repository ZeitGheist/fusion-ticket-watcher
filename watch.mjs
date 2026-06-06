#!/usr/bin/env node
// Fusion Ticket Watcher
// Überwacht das öffentliche Forum "Suche & Biete Festivaltickets" (f=82)
// und meldet NEUE Angebote (Biete-Threads). Read-only, höflich, kein Auto-Posten.
// Du antwortest immer selbst, eingeloggt, wie ein normaler Mensch.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ============== EINSTELLUNGEN (hier darfst du gern selbst schrauben) ==============
const FORUM_URL = "https://forum.fusion-festival.de/viewforum.php?f=82";
const STATE_FILE = new URL("./state.json", import.meta.url);

// Wörter, die ein ANGEBOT signalisieren (jemand gibt ein Ticket ab):
const OFFER_WORDS = [
  "biete", "verkauf", "abzugeben", "gebe ab", "zu vergeben", "zu verschenken",
  "tausche", "übrig", "ticket frei", " frei", "offering", "for sale", "to sell",
  "selling", "spare ticket", "available",
];
// Wörter, die ein GESUCH signalisieren (jemand sucht selbst — wie du, also ignorieren).
// "such" als Stamm fängt suche/sucht/suchen/gesucht in einem Rutsch.
const SEEK_WORDS = [
  "such", "brauche", "benötig", "bräuchte", "nehme",
  "looking for", "searching", "in search", "wer hat", "wanted", "wtb",
];
// Muss zusätzlich nach einem Ticket klingen:
const TICKET_WORDS = [
  "ticket", "karte", "fusionticket", "personenticket", "festivalticket",
  "bändchen", "wristband",
];

// Telegram (im Live-Betrieb per Umgebungsvariablen gesetzt;
// lokal leer = es wird nur auf dem Bildschirm ausgedruckt):
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
// =================================================================================

const DEBUG = process.argv.includes("--debug");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// HTML-Sonderzeichen (&amp; &#128640; usw.) in echten Text zurückverwandeln.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .trim();
}

// Aus dem HTML alle Threads (ID, Titel, Link) herausziehen.
function parseTopics(html) {
  const out = [];
  const seen = new Set();
  const re = /<a href="\.\/viewtopic\.php\?[^"]*?t=(\d+)[^"]*"[^>]*class="topictitle[^"]*"[^>]*>([^<]+)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: decodeEntities(m[2]), url: `https://forum.fusion-festival.de/viewtopic.php?t=${id}` });
  }
  return out;
}

// Position des ersten Treffers aus einer Wortliste (oder Infinity, wenn keiner).
function firstIndex(haystack, words) {
  let best = Infinity;
  for (const w of words) {
    const i = haystack.indexOf(w);
    if (i !== -1 && i < best) best = i;
  }
  return best;
}

// Kernlogik: Es ist ein Angebot, wenn ein Biete-Wort VOR einem Suche-Wort steht
// und es um ein Ticket geht. So wird "Suche ... - biete Dankeschön" korrekt ignoriert,
// aber "Biete Ticket, suche Autoticket" korrekt als Angebot erkannt.
function isOffer(title) {
  const t = title.toLowerCase();
  const offer = firstIndex(t, OFFER_WORDS);
  const seek = firstIndex(t, SEEK_WORDS);
  const hasTicket = TICKET_WORDS.some((w) => t.includes(w));
  return offer !== Infinity && offer < seek && hasTicket;
}

async function notify(offer) {
  const text = `🎟️ Neues Fusion-Angebot im Forum:\n${offer.title}\n${offer.url}\n→ eingeloggt im Thread antworten`;
  if (!BOT_TOKEN || CHAT_IDS.length === 0) {
    console.log("[würde pingen]", offer.title, "→", offer.url);
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
  const res = await fetch(FORUM_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.error("Forum nicht erreichbar:", res.status);
    process.exit(1);
  }
  const html = await res.text();
  const topics = parseTopics(html);

  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { notified: [] };
  const notified = new Set(state.notified);

  const offers = topics.filter((t) => isOffer(t.title));
  const fresh = offers.filter((t) => !notified.has(t.id));

  if (DEBUG) {
    console.log(`\n--- Klassifikation (${topics.length} Threads) ---`);
    for (const t of topics) console.log(`${isOffer(t.title) ? "✅ ANGEBOT " : "·· ignoriert"}  ${t.title}`);
    console.log("------------------------------------------\n");
  }

  for (const o of fresh) {
    await notify(o);
    notified.add(o.id);
  }

  // Stand nur speichern, wenn sich etwas geändert hat — spart im Cron-Betrieb unnötige Commits.
  if (fresh.length > 0 || !existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, JSON.stringify({ notified: [...notified], updated: new Date().toISOString() }, null, 2));
  }
  console.log(`Gescannt: ${topics.length} Threads | Angebote erkannt: ${offers.length} | davon neu gemeldet: ${fresh.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
