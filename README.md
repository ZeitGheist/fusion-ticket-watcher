# Fusion Ticket Watcher

Kleiner Wächter, der das öffentliche Fusion-Forum *"Suche & Biete Festivaltickets"* beobachtet
und in eine Telegram-Gruppe meldet, sobald ein echtes **Ticket-Angebot** ("Biete") auftaucht.

## Wie es läuft
- Läuft automatisch alle ~5 Minuten als GitHub Action (Cloud, 24/7, auch wenn dein Rechner aus ist).
- Liest **nur** die öffentliche Forenseite. Kein Login, kein Scraping privater Daten, kein Auto-Posten.
- Erkennt Angebote auch in ANTWORTEN auf Suche-Threads, nicht nur in Titeln.
- Meldet Treffer per Telegram-Bot in deine Telegram-Gruppe.

## Wichtig (Fairness & Regeln der Fusion)
- Das Tool **benachrichtigt nur**. Antworten tust du **selbst, eingeloggt**, wie ein normaler Mensch.
- Zahl **Originalpreis** und wickle über die **offizielle Ticket:Bourse** ab.
- Kein Bot, der für dich postet. So bleibt es im Sinne der Fusion (bewusst anti-kommerziell).

## Stoppen / Pausieren
- GitHub → dieses Repo → Tab **Actions** → Workflow *"Fusion Ticket Watcher"* → **Disable workflow**.
- Oder das Repo nach dem Festival einfach löschen.

## Suchwörter anpassen
In `watch.mjs` oben die Listen `OFFER_WORDS`, `SEEK_WORDS`, `TICKET_WORDS` bearbeiten.

## Lokal testen
```bash
node watch.mjs --debug
```
Zeigt für jeden Thread, ob er als Angebot oder Gesuch eingestuft wird (ohne zu pingen, solange keine Telegram-Variablen gesetzt sind).

## Geheimnisse
Bot-Token und Chat-ID liegen **verschlüsselt** als GitHub-Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), niemals im Code.
