# Produktive Ladezeiten

Untersucht wurde `mail.steffenvonlindern.de` am 15. Oktober 2026. Die Seite liegt hinter Cloudflare Access. Es wurden weder Zugriffskontrollen umgangen noch Anwendungssitzungen angelegt. Die Messwerte stammen aus produktiven Cloudflare-HTTP-Analytics, D1 Query Insights, tatsächlichen Abfrageplänen und gezielten Nur-Lese-Abfragen in der produktiven D1-Datenbank.

## Tatsächliche Browseranfragen

Auswertung 13:22:40–13:52:40 Uhr, Europe/Berlin. Gefiltert auf den produktiven Host, `requestSource=eyeball` und erfolgreiche HTTP-200-Antworten. Die Werte messen den Antwortbeginn am Cloudflare-Edge, ohne Browser-Rendering und ohne die gesamte Netzwerkstrecke des Nutzers.

| Anfrage / Browser | Geschätzte Anzahl | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| Nachrichtenliste / Mobile Safari | 14 | 385 ms | 9.051 ms | 9.051 ms |
| Ordnerzähler / Mobile Safari | 50 | 246 ms | 588 ms | 20.165 ms |
| Labeldefinitionen / Mobile Safari | 54 | 83 ms | 589 ms | 2.095 ms |
| Labelreihenfolge / Mobile Safari | 20 | 82 ms | 1.804 ms | 2.172 ms |
| Auftragsstatus / Chrome | 225 | 49 ms | 423 ms | 26.869 ms |
| Auftragsstatus / Mobile Safari | 26 | 52 ms | 411 ms | 8.590 ms |

Cloudflare verwendet adaptives Sampling; Anzahl und Perzentile sind Schätzungen. Besonders bei den wenigen Listenanfragen sind die oberen Perzentile einzelne beobachtete Ausreißer, keine belastbare allgemeine Verteilung. Die Werte bestätigen dennoch lange Wartezeiten bei echten Anfragen beider Browsertypen. Ein längeres Stundenfenster enthielt auch eine Listenantwort mit 19.487 ms.

Zahlreiche zusätzliche HTTP-504-Ereignisse kamen von `requestSource=earlyHintsCache` mit unbekanntem Browser und nur wenigen Millisekunden Laufzeit. Sie werden nicht als fehlgeschlagene Nutzeranfragen oder langsame Mailflare-Antworten mitgezählt. Worker-Walltime wird ebenfalls nicht als Seitenladezeit ausgegeben: Sie enthält Hintergrundarbeit und lange offene Verbindungen.

## Ursache der langen Ausreißer

Die Datenbank enthält rund 67.400 Nachrichten und ist etwa 4,47 GB groß. Zwei Hintergrundabfragen wählten einen Index, der zunächst sämtliche Nachrichten eines Postfachs beziehungsweise Besitzers durchlief und dabei die Nachrichtentabelle lesen musste:

| Hintergrundabfrage | Produktiv beobachtete SQL-Zeit | Bisheriger Plan | Abgesicherter Plan |
| --- | ---: | --- | --- |
| Eingangs-Duplikatprüfung nach MIME-Objektschlüssel | 34.450 / 37.801 ms | `messages_mailbox_read_actions_idx (mailbox_id=?)` | `messages_raw_r2_key_idx (raw_r2_key=?)` |
| Abgelaufenen Papierkorb/Spam auswählen | 8.713 ms | `messages_user_created_idx (user_id=?)` | `messages_trashed_at_idx (trashed_at<?)` |

Query Insights erfasste je Abfrage rund 67.390 gelesene Zeilen und keinen Treffer. `EXPLAIN QUERY PLAN` bestätigte dieselbe ungünstige Auswahl auf der produktiven Datenbank. D1 verarbeitet die Abfragen einer einzelnen Datenbank nacheinander; solche Scans können deshalb auch kleine Authentifizierungs-, Listen- oder Auftragsabfragen aufhalten. Beispielsweise fallen die langsame Bereinigung und ein Auftragsstatus mit 8.176 ms in dasselbe Minutenfenster um 13:05 Uhr. Das ist ein konkreter serverseitiger Engpass; es wird nicht behauptet, sämtliche beobachteten Verzögerungen hätten ausschließlich diese Ursache.

Die beiden vorhandenen Indizes werden jetzt direkt in den betroffenen SQL-Abfragen vorgegeben. Es werden keine Tabellen oder zusätzlichen Indizes angelegt. Postfach-/Besitzerauswahl, Duplikatverhalten, Status-/Fristbedingungen und das Bereinigungsbudget von 200 Nachrichten bleiben Teil der jeweiligen Abfrage.

## Direkter Produktionsvergleich

Die korrigierten Abfragen wurden vor der Veröffentlichung dreimal lesend gegen dieselbe produktive Datenbank ausgeführt. Die Duplikatprüfung verwendete einen garantiert nicht angelegten Test-Objektschlüssel; die Bereinigung führte ausschließlich `SELECT` aus. Es wurden keine Nachrichten angelegt oder gelöscht.

| Abfrage | SQL-Zeit, drei Durchläufe | Gelesene Zeilen |
| --- | --- | ---: |
| Indizierte Eingangs-Duplikatprüfung | 2,324 / 0,206 / 0,445 ms | jeweils 0 |
| Indizierte Auswahl abgelaufener Nachrichten | 1,874 / 0,208 / 0,316 ms | jeweils 1 |

Die HTTP-Roundtrips zur D1-Verwaltungs-API lagen bei 534–575 ms. Diese Netzwerkzeiten sind nicht mit den SQL-Zeiten und nicht mit dem Browserweg zur Mailflare-API gleichzusetzen. Die alten Zeitwerte stammen aus echten früheren Anfragen; die langsamen Scans wurden zur Vergleichsmessung nicht erneut ausgeführt.

## Validierung und Messgrenzen

- Der Regressionstest `background-query-performance.test.mjs` führt die tatsächlichen Eingangs-/Bereinigungshandler neben einem Archiv mit 60.000 Nachrichten aus und prüft die verwendeten SQLite-Abfragepläne ohne `ANALYZE`.
- Zusätzliche Fälle prüfen bestehende importierte IDs, gleiche Objektschlüssel in unterschiedlichen Postfächern, Wiederholungen, Besitzertrennung, aktuelle/fehlende Löschzeitpunkte, Audit-Einträge, deaktivierte Aufbewahrung und das 200-Nachrichten-Budget.
- Die bestehenden Tests für Eingangsrouting, Kategorien, Filter und endgültiges Löschen werden mit ausgeführt. Der Test ist auch Bestandteil von `npm run test:performance`.
- Die angemeldete Browseroberfläche wurde nicht ferngesteuert. LCP, INP, tatsächliche Scroll-Frames und Ende-zu-Ende-Ladezeiten dieser Sitzung sind damit nicht direkt gemessen. Die SQL-Verbesserung ist unmittelbar belegt; eine dauerhaft niedrigere produktive P95/P99 benötigt neue Anfragen und ein ausreichend großes Messfenster nach Veröffentlichung.

Quellen: [D1-Limits und Parallelität](https://developers.cloudflare.com/d1/platform/limits/), [D1-Metriken und Query Insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/). Einheiten und verfügbare Felder wurden zusätzlich am aktuellen GraphQL-Schema geprüft.
