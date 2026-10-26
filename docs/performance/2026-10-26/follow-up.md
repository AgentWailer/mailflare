# Performance-Nachprüfung und weitere Umsetzung

Baseline: `7750d88`, 26. Oktober 2026. Dieser Bericht ergänzt die [Gesamtprüfung](README.md) und [erste Leser-Optimierung](first-reader.md). Deren Architektur-, Sicherheits- und Cache-Analyse bleibt gültig: Vinext/Vite auf Workers mit Workers Static Assets, D1 in EEUR, R2, Queues und Durable Objects. Kein externer Origin. Zielregion Deutschland/Europa, Produktivdomain `mail.steffenvonlindern.de`, Cloudflare Access. Keine Architektur-/Datenmigration und keine neue kostenpflichtige Infrastruktur.

## Engpass und Änderung

Das Leser-/Editor-Bundle enthielt den vollständigen CSS-Tree-Einstieg einschließlich der CSS-Eigenschaftsgrammatik und des Validierungslexers. Der HTML-Verarbeiter nutzt nur Parser, Traversierung, Identifier-Encoding und Generator. Die dokumentierten öffentlichen Paket-Subpfade bieten dieselben Funktionen ohne die ungenutzte Initialisierung.

`src/lib/email/css-parser.ts` kapselt diese Subpfade. `css-tree-modules.d.ts` ergänzt die fehlenden Subpfad-Typen aus den vorhandenen Root-Typen. `html.ts` nutzt den Adapter; Sanitizer-Regeln, DOMPurify, Parse5, URL-/CSS-Filterung und Zugriffskontrollen wurden nicht verändert. Die vorhandene Vite-Alias-Regel für sonstige Root-Imports bleibt kompatibel.

`package.json` erweitert Performance-CI um die HTML-Sicherheitsprüfungen. `scripts/benchmark-performance.mjs` ergänzt ein Budget von **400.000 unkomprimierten JavaScript-Transferbytes nach dem ersten Mail-Klick**. Das bisherige 1,30-MB-Startbudget, CSS-/Request-/CLS- und Leserzeitbudgets bleiben erhalten.

## Vorher/nachher

Je drei unabhängige Läufe pro Bildschirmbreite, jeweils kalter und warmer HTTP-Cache; Chromium 154, Produktionsbuild, 4-fache CPU-Drosselung, konfigurierte 100 ms Netzwerklatenz, 1,5 MB/s Download, Klick 500 ms nach sichtbarer Liste, synthetische private APIs mit 100 ms Verzögerung. Während dieser Messungen keine parallelen schweren Tests. Die lokale Vorschau liefert unkomprimiertes HTTP/1.1. Vollständige p50/p75/p95 und Einzelwerte: [follow-up-measurements.json](follow-up-measurements.json).

| Messgröße | Vorher | Nachher |
| --- | ---: | ---: |
| Leser-/Editor-Chunk, Buildgröße | 394,47 KB | 273,45 KB |
| Derselbe Chunk, gzip-Buildschätzung | 114,72 KB | 81,61 KB |
| Zusätzliches JS beim ersten Klick, kalt | 472.585 B | 351.567 B |
| Erste Mail mobil, Labor-p75 kalt | 701 ms | 641 ms |
| Erste Mail Desktop, Labor-p75 kalt | 900 ms | 897 ms |
| Erste Mail mobil, Labor-p75 warm | 529 ms | 496 ms |
| Erste Mail Desktop, Labor-p75 warm | 589 ms | 608 ms |
| Sichtbare Liste mobil, Labor-p75 kalt | 3.344 ms | 3.308 ms |
| Sichtbare Liste Desktop, Labor-p75 kalt | 3.400 ms | 3.438 ms |

Der robuste Gewinn ist **26 % weniger zusätzlicher Transfer beim ersten Klick**, bzw. 31 % weniger im betroffenen Chunk. Die Laufzeitunterschiede sind klein und bei drei Läufen nicht statistisch belastbar; insbesondere wird kein Desktop-Latenzgewinn behauptet. Gzip-Schätzungen sind keine gemessenen Brotli-Produktionsgrößen. Initiales JS bleibt ungefähr 1,258 MB, CSS 128.488 B, Bilder etwa 6,7 KB, kalte Start-Requests 96. Warme Läufe übertragen kein JS erneut.

Labor-LCP-p75 kalt mobil/Desktop: vorher 700/712 ms, nachher 704/692 ms. Dieser frühe Paint misst nicht die Mailbox-Bereitschaft. CLS-p75 nachher 0; vorher Desktop etwa 0,000019. Maximale Event-Timing-Dauer kalt mobil/Desktop: 168/232 → 160/232 ms. Dies ist kein realer INP. p75 und p95 entsprechen bei drei Läufen dem langsamsten Lauf.

## Aktuelle Produktionsdaten

Read-only Cloudflare-Analytics, 25.10.2026 10:26 UTC bis 26.10.2026 10:26 UTC; adaptiv gesampelte/hochgerechnete echte Browserrequests. Das Fenster enthält mehrere Releases, deshalb kein kausaler Vorher/nachher-Vergleich.

| Erfolgreiche Route | Anzahl | Edge-TTFB p50 / p75 / p95 |
| --- | ---: | ---: |
| `/inbox` | 42 | 57 / 129 / 642 ms |
| `/api/auth/me` | 182 | 56 / 138 / 688 ms |
| Nachrichtenliste | 917 | 461 / 580 / 1.704 ms |
| Zähler | 329 | 371 / 632 / 1.333 ms |
| Leser-Navigation | 115 | 412 / 985 / 5.021 ms |

6.659 Worker-Requests, 2.147 Subrequests, 0 gemeldete Worker-Ausführungsfehler. CPU-p50/p75/p95 nach Umrechnung von Mikrosekunden: **13,375 / 25,850 / 81,943 ms**. Das ist keine Walltime. Bei der Nachrichtenliste wurden dennoch **5 HTTP-500-Antworten unter 924 Requests** beobachtet (etwa 0,54 %); hinzu kommen je ein 401 und 499. Worker-Ausführungsfehler und Anwendungs-HTTP-Fehler sind verschiedene Zähler.

Gehashtes Asset-Traffic: 297 HIT / 393 MISS unter erfolgreichen Antworten, rund **43 % HIT**, zusätzlich ein 401. MISS ist hier kein klassischer externer Origin-Zugriff. Ein unabhängiger Origin-Zugriffszähler ist nicht verfügbar. Private API-Antworten haben Cache-Status `none`.

Die neue CSS-Änderung wirkt auf Client-Transfer und Modulinitialisierung, nicht auf diese historischen SQL-/API-Ausreißer. Ihre Ursache wird nicht durch pauschales Cache-Einschalten behoben. Die bestehenden Server-Timing-Stufen erlauben die weitere Eingrenzung konkreter langsamer Requests. Historische Fehlerdetails sind aus den vorliegenden Aggregaten nicht rekonstruierbar; persistierte Worker-Logs sind deaktiviert. Die fünf HTTP-500 und die Navigations-p95 bleiben offen zu untersuchen.

## Auslieferung und offizielle Dokumentation

Am 26.10. erneut abgerufen: [Static Assets Headers](https://developers.cloudflare.com/workers/static-assets/headers/), [HTML Handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/), [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/), [Placement](https://developers.cloudflare.com/workers/configuration/placement/). Die Limits nennen weiterhin 128 MB Worker-Speicher. Es wird keine höhere Grenze angenommen.

Die vorhandene explizite [Cache-Matrix](README.md#cache-strategie) wurde mit echten lokalen Response-Headern erneut überprüft: gehashte Assets ein Jahr immutable, nicht versionierte Dateien revalidieren, HTML/RSC/personalisierte APIs privat und nicht gemeinsam gecacht, private Avatare mit Auth-Vary. Static Assets laufen über die bestehende direkte Auslieferung. Access wird nicht umgangen. Keine neuen Cache-Keys, keine Normalisierung von Nutzer-/Sprachvarianten, kein öffentliches Caching von Postfächern. Browser-Singleflight und Invalidierung nach Kontowechsel/Schreibzugriffen sind durch die CI abgesichert.

Systemfonts vermeiden externe Font-Requests. Bilder besitzen bereits feste Maße, priorisierte Avatare und Lazy Loading außerhalb des sichtbaren Bereichs. Brotli/HTTP3 waren bereits aktiv. Keine zusätzlichen Preloads, Bilddienste, Cache Rules oder Smart Placement ohne nachgewiesenen Vorteil. D1/R2 bleiben die vorhandenen Backends; Hyperdrive oder eine Datenmigration passen nicht zum belegten Engpass.

## Verifikation, CI und Betrieb

- Produktionsbuild erfolgreich; 103 Tests der erweiterten Performance-CI-Auswahl und 30 gezielte HTML-/Sicherheitsprüfungen bestanden (überlappende Suiten, nicht addieren).
- Browserprüfungen für responsive Newsletter, RTL, nachgeladene Bilder, Vergrößern/Verkleinern, externe Inhalte, aktiven Schadcode, Kontotrennung und Benutzerpräferenzen bestanden.
- Header-Prüfung bestanden. Alle zwölf Vergleichsläufe erfüllen auch das neue 400-KB-Leserbudget.
- Lokaler Lasttest mit 60.000 synthetischen Nachrichten, Parallelität 1/8, erneut erfolgreich; Antwort bleibt 109 B. Werte stehen im JSON. Kein Produktionslasttest und keine neue Backend-Beschleunigung daraus abgeleitet.
- Targeted ESLint sauber. Globales TypeScript meldet weiterhin 15 bestehende Fehler außerhalb dieser Änderungen.

Reproduktion:

```sh
npm ci
npx playwright install --with-deps chromium
npm run build
npm run test:performance:ci
node tests/browser/email-responsive.mjs
node tests/browser/external-content.mjs
PERF_RUNS=3 PERF_OUTPUT=artifacts/performance/follow-up.json npm run perf:bench
PERF_OUTPUT=artifacts/performance/load.json npm run perf:navigation
```

Vorher-Lauf auf `7750d88`, nachher auf diesem Commit, jeweils neu bauen und dieselbe Maschine/Browserkonfiguration verwenden. Bestehende GitHub-Performance-CI führt die zusätzlichen Sicherheitsprüfungen und das neue Budget aus. Reale Nutzer-LCP/INP/CLS fehlen weiterhin; ein angemeldeter Produktions-Browserlauf hinter Access ist hier nicht verfügbar. Ziele p75 LCP ≤ 2,5 s, INP ≤ 200 ms und CLS ≤ 0,1 sind daher nicht als erreicht belegt.

Rollout: Tests/Build, Commit und Push nach `main`, bestehender Cloudflare-Git-Build, aktive Version mit neuem Leser-Asset prüfen. Danach Fehlerquoten und Server-Timing anhand konkreter echter Requests beobachten. Rollback: diesen Commit mit `git revert` zurücknehmen und denselben Buildweg nutzen; keine Datenmigration oder Datenwiederherstellung nötig. Keine neuen Dienste oder Zusatzabonnements. Vertragliche Cloudflare-Kosten sind nicht aus öffentlichen Preisen ableitbar; der geringere Transfer wird nicht als pauschale Rechnungseinsparung beziffert.
