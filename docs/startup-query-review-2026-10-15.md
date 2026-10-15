# Startzeit, Datenbankabfragen und große Stapelaufträge

## Messung und Grenzen

Untersucht wurden die produktive D1-Datenbank (rund 67.000 Nachrichten insgesamt), ihre tatsächlichen Abfragepläne sowie der echte Produktionsbuild im lokalen Chromium. Es wurden keine Sitzungstoken erzeugt oder Zugriffskontrollen umgangen. Die angemeldete Produktionsseite hinter Cloudflare Access war hier nicht zugänglich. Die vom Benutzer beobachteten 20 Sekunden sind deshalb keine direkt reproduzierte Gesamtladezeit.

Die Messungen der produktiven SQL-Abfragen enthalten nur Zähler/Metadaten. Die Vergleichsabfrage liefert exakt dieselben Label-Zähler. Die Zeiten `sql_duration_ms` sind Datenbankzeiten, keine vollständigen HTTP-/Browserzeiten:

| Abfrage | SQL-Zeit | Gelesene Zeilen |
| --- | ---: | ---: |
| Bisherige Label-Zähler | 3.951 ms | 3.192.601 |
| Neue Label-Zähler, drei Durchläufe | 250 / 126 / 129 ms | jeweils 308.894 |
| Allgemeine gruppierte Ordner-Zähler | 31 ms | 67.380 |
| Konversationsköpfe, erste Seite „Alle E-Mails“ | 407 ms | 322.981 |
| Gesamtzahl Konversationen | 27 ms | 67.380 |
| Labels der sichtbaren Konversationen | 4 ms | 2.323 |
| Anhänge der sichtbaren Konversationen | unter 1 ms | 75 |

Für die Label-Abfragen betrug die HTTP-Zeit vom Prüfserver zur Verwaltungs-API vorher 4.391 ms und nachher 580–659 ms. Das ist nicht der Weg des Benutzerbrowsers zur Mailflare-API.

Cloudflare-Zoneneinstellungen wurden nur gelesen: Brotli, HTTP/3 und Early Hints sind bereits eingeschaltet. Der Browser-Cache-TTL beträgt 14.400 Sekunden. Persönliches HTML und Mail-JSON behalten `private, no-store`; diese Daten werden nicht zur Beschleunigung öffentlich zwischengespeichert. Statische Dateien mit Inhalts-Hash behalten ihre bestehenden Cache-Regeln.

## Ursachen und Korrekturen

1. **Label-Aggregation:** Die zuvor ergänzten abdeckenden Nachrichtenindizes halfen dem allgemeinen Zähler. Die zusätzliche Label-Aggregation konnte dennoch einen anderen Plan wählen: für jeden Ordner den gesamten Postfachindex durchlaufen. Ein explizites `CROSS JOIN` in der Reihenfolge Nachrichten → zugewiesene Labels → Labeldefinition sichert nun begrenzte indizierte Zugriffe ab. Der Nachrichtenindex enthält die benötigten Metadaten, ohne MIME-/Body-Seiten zu lesen. Der Test prüft diesen Plan ohne zuvor ausgeführtes `ANALYZE`, auch bei 60.000 Nachrichten und 40 Labels.
2. **Doppeltes Laden:** Der erste Statusabruf eines alten Stapelauftrags löste bisher pauschal `messages-changed` aus. Dadurch wurden ausstehende Startabfragen ungültig und erneut ausgeführt. Die initiale Statusübernahme löst keine Invalidierung aus; spätere Fortschritte und Abschlüsse weiterhin schon.
3. **Mehrfache Identitätsabfrage:** AuthGuard, Profilmenü, Seitenleiste, Dashboard-Einstellungen und CurrentUser teilen jetzt den laufenden Abruf. Nach erfolgreicher Prüfung dürfen Metadaten fünf Sekunden im Arbeitsspeicher wiederverwendet werden. Ein neuer Guard verlangt eine frische Prüfung; alle APIs prüfen ihre Berechtigungen weiter selbst. Kontowechsel löschen Cache und laufende Zuordnung, Fehler werden nicht gespeichert.
4. **Serielle Postfachabfragen:** Primärdomain und Aliasse werden zusammen geladen; die drei unabhängigen Adressinventare bilden eine weitere D1-Batchabfrage. Dadurch entfallen mehrere serielle Netzwerkwartezeiten.
5. **Unnötiges Archivieren:** Vorschau und Kandidatenauswahl filtern bereits archivierte Nachrichten heraus. Das abschließende UPDATE prüft den Zustand nochmals, auch bei wiederholten gespeicherten Chunks. Spam, Papierkorb, Entwürfe, Vorlagen und Warteschlangen-Nachrichten werden nicht durch „Archivieren“ umklassifiziert. Bestehende Archiv-Metadaten bleiben unangetastet. Gelesen/Ungelesen und Papierkorb arbeiten ebenfalls nur auf unterschiedlichen Zielzuständen.
6. **Messbarkeit:** Erfolgreiche Antworten von Authentifizierung, Postfachliste, Zählern und Nachrichtenliste enthalten `Server-Timing`. Die Stufen zeigen Authentifizierung, Zugriffsprüfung, eigentliche Listenabfrage und Metadatenanreicherung getrennt. Die Header enthalten keine Inhalte, Identitäten oder Schlüssel.

Der aktive Archivierungsauftrag mit ursprünglich 63.945 Einträgen wurde für die Korrektur bei gespeichertem Fortschritt 880 pausiert. Nach Prüfung des automatischen Deployments wird derselbe Auftrag mit seinem ursprünglichen Auswahlzeitpunkt und den noch erforderlichen Nachrichten fortgesetzt. Der Snapshot wird nicht erweitert.

## Wiederholbare Prüfungen

Nach `npm run build`:

```bash
npm run test:performance
```

Falls Playwright und Chromium außerhalb der üblichen Modul-/Browserpfade installiert sind, `MAILFLARE_PLAYWRIGHT_MODULE` und `MAILFLARE_CHROMIUM_EXECUTABLE` setzen. Der Browser-Test startet und beendet ausschließlich seinen eigenen lokalen Preview. Private APIs liefern synthetische Daten; ihre Zeiten sind keine Live-Messungen des Benutzerpostfachs.

Die Prüfungen sichern ab:

- genau eine Authentifizierungs-, Listen- und Zählerabfrage beim Start, auch wenn ein abgeschlossener 60.000-Nachrichten-Auftrag vorhanden ist;
- unter 1,35 MB unkomprimiertes Start-JavaScript, keine vorab geladenen geschlossenen Editoren/Assistenten oder fremden Ordnerseiten;
- bedienbare Liste und erster E-Mail-Klick trotz eines absichtlich sechs Sekunden verzögerten optionalen Zählers;
- sichere Kontowechsel, erneute Sitzungsprüfung und Fehlerwiederholung;
- indizierte Label-Aggregation und korrekte Zugriffstrennung;
- Archivieren mit 60.000 bereits archivierten Nachrichten verändert nur die beiden noch offenen Testnachrichten und erzeugt nur dafür Sync-/Audit-Einträge;
- unveränderte Bedienbarkeit von ganzen Zeilen, Checkboxen, Sternen, Tastatur, frühem Zurück und wiederholten Nachrichtenklicks.

Unter vierfacher CPU-Drosselung, leerem Cache, 100 ms Netzwerklatenz und 1,5 MB/s Downloadrate wurde die synthetische Liste nach etwa 4,1 Sekunden am Desktop bzw. 3,9 Sekunden mobil sichtbar. Erste Auswahlbestätigung: 14 ms. Das sind kontrollierte Regressionstests, keine zugesicherte Startzeit in der produktiven Browsersitzung. Globale Typprüfung: unverändert 15 vorhandene Fehler; keine neuen Fehler. Fokussierter Lint neuer Backend-/Sitzungslogik ist sauber; bereits bestehende Effekt-Regelverletzungen in Profil-/Sidebar-Komponenten sind separat bekannt.
