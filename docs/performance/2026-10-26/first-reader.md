# Erste Nachricht nach dem Neuladen

Der Nutzer beobachtet die Verzögerung nur beim ersten Öffnen einer Nachricht nach einem App-Neustart. Vergleichsbasis ist `b4d7fe4`. Der kontrollierte Browserlauf reproduziert einen Unterschied zwischen erster und späterer Öffnung bei konstanten synthetischen API-Antworten von 100 ms: Der erste Klick lädt bisher zusätzlich **498.733 B JavaScript**. Dazu gehören der sichere HTML-Verarbeiter und Leser-Abhängigkeiten. Das belegt einen Browser-Engpass, schließt zusätzliche produktive Worker-/D1-/R2-Latenz aber nicht aus.

## Umsetzung

- `reader-preload.ts`, `mailbox-preload.ts`, `use-mailbox-preload.ts`: Nach sichtbarer Liste und mindestens 750 ms ohne Interaktion wird das Leser-Modul vorbereitet, bevor die bereits vorhandene Ordner-Vorbereitung beginnt. Verwendet wird der vorhandene Idle-Scheduler. Ausgeblendete Tabs, Offline-Zustand, Datensparmodus und 2G unterbinden die automatische Vorbereitung. Ein einmal gestarteter Modulimport lässt sich nicht abbrechen. Navigation/Sitzungswechsel verhindern nachfolgende Daten-Vorbereitung.
- `message-navigation.tsx`: Klick, Fokus, Touch-Absicht und verzögertes Hover bereiten dasselbe Modul vor. Gleichzeitige Aufrufe teilen ein Promise; fehlgeschlagene Imports lassen sich beim nächsten Öffnungsversuch wiederholen. Entwurfs-Links starten diese Leser-Vorbereitung nicht.
- `message-actions.tsx`, `thread-message-actions.tsx`: Originalansicht, Filterdialog und Snooze-Dialog werden erst bei Bedarf geladen. Beide Leser-Aktionsleisten müssen ihre Original-/Filterdialoge bedarfsgeladen importieren, damit keine statische Referenz die Aufteilung verhindert.
- `inbound.ts`, Detail-API: Nach unveränderter Berechtigungsprüfung laufen Kontaktauflösung, Anhänge und der begrenzte R2-Header-Abruf parallel. `Server-Timing` zeigt `auth`, `lookup`, `access`, `metadata`, jeweils die Dauer seit der vorherigen Markierung. Die JSON-Serialisierung und die Rückübertragung liegen außerhalb dieser Stufen. Die Antwort bleibt `private, no-store`.

Das vorbereitete Leser-Modul wird **nicht gerendert**: Es werden dabei weder Nachrichteninhalte abgerufen noch Nachrichten als gelesen markiert. HTML-Sanitizer und Zugriffskontrollen bleiben erhalten. Es gibt keinen öffentlichen Mail-Cache und keine künstlichen Worker-Warmhalte-Requests.

## Gemessene Wirkung

Je drei unabhängige Browserkontexte pro Breite, jeweils kalter und warmer Browser-HTTP-Cache; Chromium 154, 4-fache CPU-Drosselung, konfigurierte 100 ms Netzwerklatenz, 1,5 MB/s Download. Tatsächlicher Produktionsbuild, lokale Vorschau ohne HTTP-Kompression, synthetische private APIs. Keine parallelen schweren Testläufe während der Messung. Alle p50/p75/p95 und Einzelwerte stehen in [first-reader-measurements.json](first-reader-measurements.json).

| Erster Klick nach Neustart, Browser-Cache kalt, Labor-p75 | Vorher | Nachher |
| --- | ---: | ---: |
| Mobil, 2.500 ms nach sichtbarer Liste | 1.218 ms | 633 ms |
| Desktop, 2.500 ms nach sichtbarer Liste | 1.434 ms | 821 ms |
| Mobil, bereits 500 ms nach sichtbarer Liste | 1.236 ms | 1.231 ms |
| Desktop, bereits 500 ms nach sichtbarer Liste | 1.443 ms | 991 ms |
| Zusätzliches JavaScript nach Klick, nach 2.500 ms Leerlauf | 498.733 B | 0 B |

Nach kurzer Leerlaufphase wird die erste Öffnung damit etwa 48 % (mobil) bzw. 43 % (Desktop) schneller. Bei einem sofortigen mobilen Klick zeigt p75 noch keinen belastbaren Gewinn. Die Vorbereitung ist eine zeitliche Verlagerung: Nach 2.500 ms wurden im kalten Browser insgesamt rund **1,73 MB** JavaScript übertragen, statt vorher rund 1,26 MB vor dem Klick. Wer keine Nachricht öffnet, lädt diese zusätzlichen Lesermodule trotzdem. Die 500-ms-Messung bleibt bei rund **1,258 MB**, unter dem bestehenden 1,30-MB-Startbudget. Diese unkomprimierten Laborwerte sind keine Brotli-Produktionsgrößen.

Die sichtbare Liste bleibt bei ungefähr 3,4 s Labor-p75; dafür wird kein zusätzlicher signifikanter Gewinn behauptet. Warme erste Öffnungen nach 2.500 ms liegen nachher bei 568 ms mobil und 698 ms am Desktop. Drei Läufe ergeben keine belastbare Feldverteilung; p75/p95 entspricht hier jeweils dem langsamsten Lauf. Das sind keine realen Nutzer-INP-/LCP-Werte.

## Prüfung und Reproduktion

Produktionsbuild erfolgreich. 83 Tests der aktualisierten Performance-CI-Auswahl erfolgreich, dazu die Sicherheitsregressionen aus dem gezielten 39-Test-Lauf. Echte Browserprüfungen sichern den ersten Klick, schnelle Folge-Klicks, Abbruch, Retry nach Fehler, verzögerte Composer-/Assistant-Initialisierung, ganze anklickbare Zeilen, Ordner-Vorbereitung ohne Nachrichtendaten-Abruf und die bedarfsgeladenen Original-/Filterdialoge auf sieben Bildschirmgrößen ab. Alle zwölf sofortigen Vergleichsläufe halten die bestehenden JS-/CSS-/Request-/CLS-/Leserbudgets ein.

`tsc --noEmit` meldet weiterhin 15 bestehende Fehler außerhalb der Änderungen. Targeted ESLint zeigt dieselben vier bestehenden Fehler und eine Warnung wie `b4d7fe4` in drei bearbeiteten Komponenten; neue Dateien und übrige bearbeitete Quellen sind ohne neue Diagnosen.

```sh
npm ci
npx playwright install --with-deps chromium
npm run build
npm run test:performance:ci
node tests/browser/cold-start.mjs
node tests/browser/mailbox-preload.mjs
node tests/browser/message-action-menus.mjs
PERF_RUNS=3 PERF_READER_IDLE_MS=500 PERF_OUTPUT=artifacts/performance/first-reader-immediate.json npm run perf:bench
PERF_RUNS=3 PERF_READER_IDLE_MS=2500 PERF_OUTPUT=artifacts/performance/first-reader-idle.json npm run perf:bench
```

Die CI schützt zusätzlich die Idle-/Sitzungssteuerung und die parallele, berechtigungsgeprüfte Detailanreicherung. Das Startbudget wird bei 500 ms geprüft, nicht nach absichtlich abgeschlossenem Leser-Preload.

## Produktion, Kosten, Rollout und Rücknahme

Cloudflare Access verhindert weiterhin eine angemeldete Browsermessung der echten Mailbox in dieser Umgebung. Die neuen `Server-Timing`-Header ermöglichen beim nächsten echten Abruf die Abgrenzung von Authentifizierung, Nachrichtennachschlag, Zugriffsprüfung und Zusatzdaten. Die Labormessung belegt keine Verringerung produktiver API-p95 oder Worker-Kaltstartzeit.

Rollout über Commit und Push nach `main`, anschließend bestehender Cloudflare-Git-Build; keine direkte Wrangler-Veröffentlichung und keine Migration. Aktive Deployment-Version und neue Bundle-/Timing-Merkmale werden über die Verwaltungs-API geprüft. Zur Rücknahme den Änderungscommit auf `main` mit `git revert` zurücknehmen und den normalen Build veröffentlichen; Daten bleiben kompatibel. Keine neuen Dienste oder Tarifoptionen. Es entstehen gegebenenfalls zusätzliche vorhandene Asset-Auslieferungsbytes für Sitzungen ohne geöffneten Leser; konkrete vertragliche Kosten sind daraus nicht ableitbar.
