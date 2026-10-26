# Performance-Prüfung Mailflare – 26. Oktober 2026

Nachprüfung: [Erste Nachricht nach dem Neuladen](first-reader.md) mit separaten Vergleichsmessungen und Leser-Vorbereitung.

Die Umsetzung behält Vinext/Vite 8 auf Cloudflare Workers mit Workers Static Assets, D1, R2, Durable Objects und Queues bei. Produktivziel ist `https://mail.steffenvonlindern.de`, geschützt durch Cloudflare Access. Hauptzielregion ist Deutschland/Europa. Die Produktions-D1 antwortete aus **EEUR**, hat rund **4,66 GB**, und Read Replication ist deaktiviert. Der Account besitzt **Workers Paid for Enterprise**, die Zone **Enterprise Website**. Vertragspreise sind nicht aus der Konfiguration ableitbar.

## Messbarer Vergleich

Ausgangsstand: Commit `a784241`. Fünf Läufe je Kombination, tatsächlicher Produktionsbuild mit synthetischen privaten APIs (100 ms Antwortverzögerung), Chromium 154, Node 24, 4-fache CPU-Drosselung, konfigurierte 100 ms Netzwerklatenz, 1,5 MB/s Download. 390 bzw. 1440 Pixel, englische Anwendung mit deutscher Browser-Locale. Die Vorschau läuft über HTTP/1.1 ohne HTTP-Kompression. Ein lokaler HTTP-Proxy liefert die Test-APIs; Playwright-Request-Routing wird bewusst nicht eingesetzt, weil es den Browser-HTTP-Cache deaktivieren kann. Warme Läufe haben nachgewiesene Cache-Treffer und **0 erneut übertragene JavaScript-Bytes**.

| Browserablauf, p75 im Labor | Vorher | Nachher | Änderung |
| --- | ---: | ---: | ---: |
| Mobile Mailbox sichtbar, kalt | 3.968 ms | 3.362 ms | −15 % |
| Desktop-Mailbox sichtbar, kalt | 4.302 ms | 3.418 ms | −21 % |
| Mobile Mailbox sichtbar, warm | 1.460 ms | 1.325 ms | −9 % |
| Desktop-Mailbox sichtbar, warm | 1.534 ms | 1.443 ms | −6 % |
| Mobile Nachricht nach Klick, warm | 809 ms | 590 ms | −27 % |
| Desktop-Nachricht nach Klick, warm | 1.247 ms | 700 ms | −44 % |
| Mobile maximale Ereignisdauer, warm | 176 ms | 112 ms | −36 % |
| Desktop maximale Ereignisdauer, warm | 304 ms | 144 ms | −53 % |
| Start-Requests, kalt | 140 | 96 | −31 % |
| JavaScript-Transfer, kalt/unkomprimiert | 1.271.794 B | 1.255.604 B | −1,3 % |
| CSS-Transfer, kalt/unkomprimiert | 128.488 B | 128.488 B | unverändert |

Die maximale Event-Timing-Dauer ist eine **Labor-Interaktionsmessung, kein realer INP**. Im kalten Desktop-Lauf liegt deren p75 noch bei **224 ms**. Gemessener Labor-LCP (mobil/Desktop, kalt) liegt vorher bei 644/628 ms und nachher bei 712/720 ms: Diese frühe Paint-Metrik wurde leicht schlechter, obwohl die nutzbare Mailbox deutlich früher erscheint. LCP allein misst hier die Funktionsbereitschaft der App nicht ausreichend. CLS-p75 bleibt bei 0 (vorher Desktop kalt etwa 0,000019). Fünf Läufe sind wenig; p95 ist hier der größte einzelne Messwert, keine belastbare Feldverteilung. Sämtliche p50/p75/p95 stehen in [measurements.json](measurements.json).

### Navigation und Last

Die bisherige Leser-Navigation las/serialisierte **alle** Nachrichten des Ordners in Worker und Browser. Bei 60.000 synthetischen Nachrichten waren das **2.040.014 B**, mit Konversationen **1.020.014 B**. Der aktuelle Leser fordert anhand seiner Nachrichten-ID nur Position und zwei Nachbarn an: **109 B**, bei unverändert exakter Position/Gesamtzahl.

Lokaler Integrationstest einschließlich Handler und JSON, ohne externes Netzwerk:

| Modus | Parallelität | p50 vorher/nachher | p95 vorher/nachher |
| --- | ---: | ---: | ---: |
| Einzelmails | 1 | 61 / 32 ms | 79 / 37 ms |
| Einzelmails | 8 | 273 / 121 ms | 545 / 233 ms |
| Konversationen | 1 | 60 / 50 ms | 70 / 50 ms |
| Konversationen | 8 | 277 / 217 ms | 533 / 402 ms |

Für Nachrichten innerhalb der bereits geladenen Seite nutzt der Leser die sitzungsgebundenen Listenmetadaten; pro Klick entsteht dort keine zusätzliche Navigationsabfrage. Unbekannte Seitennachbarn und Direktlinks verwenden die begrenzte Serverantwort. Fokus-/Mitgliedschaftsänderungen werden neu geprüft. Ein eigener Regressionstest sichert Wiederverwendung, Seitengrenzen und die erneute Prüfung nach Rückkehr in die App ab.

Das ist ein lokaler SQLite-/D1-Adapter mit einem Node-Prozess, kein verteilter Lasttest und keine Messung der Worker-CPU. Es wurde **kein Lasttest gegen Produktion** ausgeführt. Rückwärtskompatible Requests ohne Nachrichten-ID bleiben für ältere offene Tabs verfügbar; neue Leser nutzen die begrenzte Antwort.

## Produktive Ausgangsdaten und Grenzen

Cloudflare-Analytics des vorausgehenden 24-Stunden-Fensters, nur tatsächliche Browseranfragen (`requestSource=eyeball`), adaptiv gesampelt/hochgerechnet:

| Erfolgreiche Antwort | Ungefähre Anzahl | Edge-TTFB p50 / p75 / p95 |
| --- | ---: | ---: |
| Mailbox-HTML `/inbox` | 37 | 58 / 124 / 658 ms |
| Nachrichtenliste | 865 | 459 / 580 / 1.626 ms |
| Ordnerzähler | 303 | 374 / 682 / 1.333 ms |
| Leser-Navigation | 73 | 611 / 1.293 / 5.474 ms |
| Anmeldung/Identität | 112 | 70 / 261 / 2.077 ms |

Diese Werte messen den Antwortbeginn am Edge, nicht Browser-Rendering oder den gesamten Nutzer-Netzwerkweg. Worker-Analytics erfassten 5.054 Requests, 0 Worker-Ausführungsfehler und 1.995 Subrequests. CPU-p50/p75/p95: **15,944 / 30,129 / 93,945 ms**. Die Einheit wurde im GraphQL-Schema geprüft: `cpuTime*` sind Mikrosekunden, `duration*` dagegen **GB·s und keine Walltime**. HTTP-Anwendungsfehler sind nicht mit Worker-Ausführungsfehlern gleichzusetzen.

Für gehashte Assets: 129 HIT / 299 MISS, etwa **30,1 % HIT** in diesem gesampelten Fenster. MISS bedeutet hier keinen Zugriff auf einen externen Web-Origin: Die Architektur hat keinen klassischen externen Web-Origin. Ein belastbarer zusätzlicher Origin-Zähler wurde nicht erhoben. Private API-Antworten wurden mit Cache-Status `none` beobachtet; deren öffentliche Cache-Trefferrate soll nicht erhöht werden.

Die neue Navigationsabfrage wurde zusätzlich **sechsmal ausschließlich lesend** gegen Produktions-D1 geprüft: Einzelmails etwa **66–70 ms**, Konversationen **125–376 ms SQL-Zeit**, jeweils 0 geschriebene Zeilen. EXPLAIN bestätigt die vorhandenen abdeckenden Metadatenindizes. Es werden weiterhin mehrere Durchgänge über Metadaten für exakte Positionen benötigt; die Abfrage ist keine O(1)-Operation. Verwaltungs-API-Roundtrips, Authentifizierung und Browsernetzwerk sind in diesen SQL-Zeiten nicht enthalten. Die alte große Anfrage wurde nicht zur Lastsimulation in Produktion wiederholt. Diese SELECT-Messung belegt noch keine neue produktive API-p95.

**Reale Nutzer-LCP/INP/CLS sind nicht verfügbar.** Für diese Domain wurde kein zugänglicher RUM-Datensatz gefunden. Cloudflare Access verhinderte einen angemeldeten Produktions-Browserlauf; ein anonymer Asset-Abruf antwortete korrekt mit HTTP 401 und `no-store`. Ein Lighthouse-/Observatory-Lauf gegen die Access-Anmeldeseite würde nicht die Mailbox messen. Ziele am realen p75 bleiben **LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1**; deren Erreichen wird nicht behauptet.

## Änderungen nach Priorität

1. **Leser-Navigation:** `src/lib/messages/navigation-window.ts`, Navigations-API und Leser-Kontext. Die Datenbank liefert wenige skalare Werte statt zehntausender JS-Objekte. Konversationsköpfe, Suchfilter, Spam-Option, Zugriff auf Postfächer und Sortierung bei gleichen Zeitpunkten bleiben erhalten. Authentifizierungs-/Navigationszeit werden über `Server-Timing` sichtbar. Keine Migration, keine neuen Indizes.
2. **Frontend-Auslieferung:** `vite.config.ts` bündelt kleine UI-Abhängigkeiten ausschließlich im Client-Build über die von Vite 8/Rolldown unterstützte `codeSplitting.groups`-Konfiguration. Das reduziert Modul-Requests. Tastenkürzel-Palette und Hilfe laden erst beim Öffnen; statische Barrel-Reexports, die das verhinderten, wurden entfernt. PDF, Editor und KI-Assistent bleiben bedarfsgeladen. Renderingarchitektur und Oberfläche bleiben bestehen.
3. **Interaktionen:** `src/lib/time/utils.ts` verwendet begrenzte Caches für Intl-Formatierer und Zeitzonenprüfung (je höchstens 64 Einträge). Schlüssel berücksichtigen Sprache, Zeitzone und Formatoptionen; Benutzerpräferenzen werden weiterhin direkt gelesen. Änderungen der Gerätezeitzone werden spätestens nach einer Minute erkannt. Für 1.000 Formatierungen sank die isolierte Laufzeit von etwa 120–145 ms auf rund 2 ms warm; der erste neue Lauf benötigte etwa 17 ms. Das ist ein Mikrobenchmark, keine Seitenladezeit.
4. **Cache-Isolation:** `src/lib/http/cache-policy.ts` überschreibt versehentlich öffentliche Policies personalisierter APIs mit `private, no-store`. Explizite private Browser-Caches, etwa Profilbilder, erhalten `Vary: Cookie, Authorization`. Antworten mit Session-Cookies und fehlende Assets werden nicht öffentlich gespeichert.
5. **Messung/CI:** reproduzierbare Browser-, Navigations- und Header-Skripte, Cache-/Berechtigungs-/Zeitformat-Regressionstests, gepinnte Playwright-Entwicklungsabhängigkeit und `.github/workflows/performance.yml`.

## Cache-Strategie

| Routentyp | Browser | Öffentlicher Edge-Cache / Auslieferung |
| --- | --- | --- |
| `/_next/static/*`, einschließlich versionierter PDF-Ressourcen | 1 Jahr, `immutable` | Bestehende Workers Static Assets, standardmäßig vor Worker-Script; Access-Schutz bleibt bestehen |
| `/sender-logos/*` | 1 Tag | Öffentliches statisches Artwork, keine privaten Kontaktbilder |
| `/locales/*` | `max-age=0, must-revalidate`, ETag | Nicht versionierte Kataloge werden revalidiert |
| `/sw.js` | `no-cache` | Aktualisierungen werden geprüft; kein Offline-Mailcache |
| `/manifest.webmanifest` | `no-cache` | Worker-generierte Metadaten; Policy im Worker statt wirkungslosem `_headers`-Eintrag |
| HTML, RSC, Mail-/Konto-/Kalender-JSON | `private, no-store` | Kein gemeinsamer Cache |
| Private Avatare/geschützte Bilder mit expliziter TTL | Privat mit bestehender TTL, ETag und Auth-Vary | Kein gemeinsamer Cache |
| `/api/branding/icon` | Bestehende globale Icon-Policy | Einzige Ausnahme vom allgemeinen API-Schutz; keine Nutzerdaten; Session-Cookies erzwingen trotzdem `no-store` |

Browser- und Edge-Cache bleiben getrennt. Es werden keine Cache-Keys normalisiert und keine vertraulichen Antworten über Cache Rules, Cache API oder KV geteilt. Bereits vorhandene laufende Client-Requests werden weiterhin zusammengeführt und nach Schreibzugriffen/Kontowechsel verworfen. Die Cache API wäre hier kein Ersatz für die Auslieferung statischer Assets: Sie ist lokal zum jeweiligen Rechenzentrum und unterstützt keine Tiered-Cache-Verteilung wie der normale CDN-Pfad.

Schriften verwenden bereits den lokalen System-Font-Stack; es werden keine Font-Dateien oder externen Font-Dienste nachgeladen. Avatare besitzen bereits priorisierte bzw. verzögerte Bildabrufe, asynchrones Decoding und private, versionierte Bildantworten; diese Pipeline wurde erhalten. Der synthetische Bildtransfer blieb bei etwa 6,7 KB kalt. Private Originalfotos und große Anhänge wurden nicht als vermeintliche LCP-Bilder vorgeladen. Es wurden keine zusätzlichen Preconnects oder Bilddienste aktiviert.

Brotli, HTTP/3 und Early Hints sind bereits aktiv; Rocket Loader ist aus. Keine dieser Einstellungen wurde pauschal umgestellt. `assets.run_worker_first` bleibt beim bestehenden Standard: statische Treffer zuerst. Smart Placement wird ohne A/B-Nachweis nicht aktiviert; die Daten liegen bereits in Europa. Keine Einführung von KV/Hyperdrive, keine D1-Replikation und kein Framework-Wechsel.

## Reproduktion und CI

```sh
npm ci
npx playwright install --with-deps chromium
npm run build
PERF_RUNS=5 PERF_OUTPUT=/tmp/before-or-after.json npm run perf:bench
PERF_OUTPUT=/tmp/navigation.json npm run perf:navigation
npm run perf:headers
npm run test:performance:ci
```

Bei vorhandenem Chromium können `MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium` und ein abweichendes Playwright-Modul über `MAILFLARE_PLAYWRIGHT_MODULE` gesetzt werden. Baseline und Kandidat müssen mit identischem Browser, Rechner und Bedingungen separat gebaut werden. Für eine Chrome-Performance-Trace (synthetische Daten, kein Produktivkonto):

```sh
PERF_RUNS=1 PERF_TRACE=1 PERF_OUTPUT=/tmp/trace-run.json npm run perf:bench
```

Die erzeugte `trace-run.trace.json` lässt sich in Chrome DevTools Performance laden. Trace-Läufe verursachen Mess-Overhead und gehören nicht in den numerischen Vergleich. Vollständige Browser-Rohdaten und die etwa 1,9 MB große Trace wurden im lokalen Prüfbereich erzeugt; CI veröffentlicht seine Messdateien als Actions-Artefakte. Die verdichteten tatsächlichen Resultate sind hier versioniert.

CI prüft u. a. höchstens **1,30 MB unkomprimiertes Start-JS**, **140 KB CSS**, **110 Start-Requests**, CLS ≤ 0,1, eine erste Leseröffnung unter 3 s im Test und echte warme Cache-Treffer. Zeitwerte schwanken mit Runner/Browser; die Wunschbudgets für einen fest kalibrierten Läufer sind Mailbox p75 kalt ≤ 3,5 s, warm ≤ 1,5 s und Interaktionsereignisse p75 ≤ 200 ms. Der kalte Desktop verfehlt das letzte Laborziel mit 224 ms noch leicht. Das ersetzt keine realen Web-Vitals.

Validierung dieser Umsetzung: **66 gezielte automatisierte Prüfungen bestanden**, außerdem die Kaltstart-/Leser-/Shortcut-Szenarien auf Desktop und Mobil, 15 Such-Browser-Szenarien und die HTTP-Header-/304-Prüfung. Build und gezieltes ESLint sind erfolgreich.

Die Workflow-Checks laufen bei Pull Requests und Push nach `main`. Cloudflares bestehender Git-Build ist davon unabhängig: Diese Checks sind noch kein Branch-Protection-/Deployment-Gate. Vor diesem Rollout wurden die lokalen Prüfungen ausgeführt. Die globale Typprüfung besitzt weiterhin die bekannten 15 unabhängigen Fehler; keine neuen Fehler in den geänderten Modulen.

## Rollout, Beobachtung und Rollback

1. Lokale Cache-/Berechtigungs-/Navigationsprüfungen, Produktionsbuild und Browser-Szenarien abschließen. Keine Produktions-Lasttests.
2. Commit nach `main` pushen; bestehender Cloudflare-Git-Build veröffentlicht. Aktive Worker-Version auf neue Navigations-/Cache-Codepfade prüfen. Einmal Mailflare neu laden, damit bereits offene Tabs den neuen Client verwenden.
3. In den nächsten 24–48 Stunden echte Listen-/Navigations-TTFB, Worker-CPU und Fehlerraten mit demselben Host-/Request-Source-Filter vergleichen. Ohne ausreichende Stichprobe keine produktive Verbesserung behaupten. Für LCP/INP/CLS anschließend datensparsame RUM-Erfassung für die geschützte App einrichten bzw. den vorhandenen Messzugang bereitstellen.
4. Bei neuen 5xx, kaputten Pfeilen/Shortcuts oder Cache-Problemen: den Performance-Commit mit `git revert <commit>` zurücknehmen und normal über `main` ausliefern. Ohne Datenbankmigration ist kein Daten-Rollback nötig. Für einen akuten vollständigen Worker-Rollback kann ein Administrator die vorherige Deployment-Version in Cloudflare aktivieren; dabei auch die zugehörigen statischen Assets/Client-Dateien berücksichtigen. Der konsistente Standardweg bleibt Git-Revert plus Neubuild.

Keine neuen Cloudflare-Ressourcen oder kostenpflichtigen Features wurden aktiviert. Bestehende Request-/D1-Nutzung bleibt tarifabhängig; zusätzliche GitHub-Actions-Läufe können CI-Minuten verbrauchen. Konkrete Enterprise-Vertragspreise und ein künftiges RUM-Kontingent wurden nicht erfunden.

## Offizielle Referenzen

- [Workers Static Assets: Routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Static Assets: `_headers`](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Workers-Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Placement](https://developers.cloudflare.com/workers/configuration/smart-placement/)
- [D1 Read Replication und Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/)
- [Workers Cache / Tiered Cache](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers GraphQL Analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [Rolldown Code Splitting](https://rolldown.rs/in-depth/manual-code-splitting)
