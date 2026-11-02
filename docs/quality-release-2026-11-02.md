# Qualitätsverbesserungen vom 2. November 2026

Umsetzung der neun Befunde des Qualitätschecks gegen `089a1dd`. Die vorhandene
Cloudflare-Architektur bleibt erhalten. Dieses Release enthält keine neue
Datenbankmigration, keinen neuen kostenpflichtigen Dienst und keine Änderung an
Cloudflare Access oder an den produktiven Maildaten durch die Tests.

## Änderungen und zugehörige Regressionen

| Befund | Umsetzung | Wesentliche Prüfungen |
| --- | --- | --- |
| Q1: Inhalt nach AI-Sendefreigabe verändert | Atomare Reservierung der geprüften Revision; Versand mit den tatsächlich geprüften Anhangsbytes. AI-, Browser- und Drive-Änderungen respektieren die Reservierung. | `send-integrity.test.mjs`: parallele Bearbeitung, Freigabeablauf, geänderte Dateien, verlorene Schreibantworten, Aufräumfehler |
| Q2: Versand nach Protokollfehler als gescheitert angezeigt | Providerbestätigung getrennt von Audit/Webhook-Nacharbeit speichern; gespeicherten Erfolg bei verlorener Datenbankantwort erhalten. Unklaren Transportausgang niemals automatisch erneut senden. | `scheduled-send-race.test.mjs`: bestätigter Versand, verlorene Antworten, konkurrierende Worker, Nacharbeit |
| Q3: Fehlende Anhänge still ausgelassen | Fehlende registrierte Datei verhindert Versand und Kopie; Entwurf bleibt erhalten, konkrete deutsche Meldung mit Dateiname. | `send-integrity.test.mjs`, `compose-send-error.test.mjs` |
| Q4: Alter Restore löscht vor Validierung | Cloudflare-Live-Import liefert nach Berechtigungsprüfung 410. Lokaler kleiner Legacy-Import validiert Schema/Daten vollständig und schreibt atomar. Rescue stellt weiterhin in neue Ressourcen wieder her. | `backup-restore-safety.test.mjs`, `external-content-settings.test.mjs` |
| Q5: Unvollständige Qualitätsfreigabe | Typ- und Lintfehler sowie veraltete Tests bereinigt. Standardbuild führt Typprüfung, Lint ohne Warnungen und sämtliche gewöhnlichen Tests vor Vite aus; CI zusätzlich Browser- und Performanceprüfungen. | `npm run check:quality`, `npm run test:smoke`, `npm run test:performance:ci` |
| Q6: Sicherheitswartung | Kompatible Paketupdates; MCP-Eingaben auf tatsächliche Bytes und JSON-Komplexität begrenzen. Browser speichert keine Bearer-Sessiontokens mehr. CSP verbietet JavaScript-eval, erlaubt PDF-WebAssembly. | Auth-/MCP-/HTML-/Anhangstests, `npm audit`; verbleibende Entwicklungsabhängigkeiten siehe `security-dependencies.md` |
| Q7: Widersprüchliche Betriebsanleitungen | Ein aktueller Einstieg für Fork, Installation, additive Migrationen, Freigabe, Rescue, OAuth und Rollback. | `operations.md` und aktualisierte verlinkte Anleitungen |
| Q8: Verlorene Aufträge und unsichtbare Endfehler | Atomare Veröffentlichung des Versandauftrags. Begrenzte Cron-Wiederaufnahme sicher noch nicht gestarteter geplanter Sendungen; unsichere Zustellung separat anzeigen. Inhaltsfreie letzte Queue-Fehler im Administrationsbereich. | `scheduled-send-race.test.mjs`, `queue-failure-visibility.test.mjs`, Browserprüfung der Statuskarte |
| Q9: Alltagsfeedback und Deutsch | Sternaktionen mit gespeichertem Zielzustand, Mehrfachklickschutz, sichtbarer Fehlermeldung und Wiederholung. Stern bleibt bei Hover erreichbar. Deutsche Schlüssel vollständig, „Soziale Netzwerke“ einheitlich. Fehler beim Abmelden und gesperrten Entwürfen verständlich. | `message-star.test.mjs`, `i18n.test.mjs`, `auth-browser-session.test.mjs`, `tests/browser/message-star-feedback.mjs` |

## Reproduzierbare Abnahme

```sh
npm ci
npm run check:quality
npm run test:smoke
npm run test:performance:ci
npm run perf:navigation
npm audit --omit=dev
npm audit
```

Browserprüfungen laufen nacheinander gegen den gebauten lokalen Worker bzw. bei
isolierten Komponenten gegen gebündelten aktuellen Quellcode. API-Antworten und
Maildaten sind synthetisch. Unter Linux kann
`MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium` einen installierten Chromium
wählen. Die Tests versenden keine echten Nachrichten und führen keinen
Produktionslasttest durch.

Der Build startet den erzeugten Worker zusätzlich für echte HTTP- und
Cache-Prüfungen. Diese Prüfung fing eine Inkompatibilität zwischen dem
aktualisierten Bundler und Vinexts generierten Begleitdateien ab: Das Worker-Modul
wird nun ausdrücklich neben diese Dateien geschrieben. Client-Dateipfade und
Cloudflare-Architektur bleiben unverändert.

## Rollout und Rückfall

1. Kandidat durch die obigen Prüfungen freigeben; keine Schemaänderung für dieses
   Release erforderlich. Aktive Worker-Version und Git-Revision festhalten.
2. Über die bestehende Git-/Cloudflare-Verbindung veröffentlichen. Einen
   erfolgreichen Build und 100 % Traffic auf der neuen Version prüfen.
3. Anmeldung, Öffnen einer Mail/PDF, Entwurfsbearbeitung, Sternfehler/-wiederholung,
   deutsche Kategorien und sichtbaren Versandstatus prüfen. Echte Zustellung nur
   mit einem absichtlich gewählten Testempfänger prüfen.
4. Bei einer Regression zuerst betroffenen Commit über denselben Weg
   zurücknehmen bzw. vorherige Worker-Version samt Assets aktivieren. Nicht die
   gesamte Mailbox-Datenbank zurücksetzen. Vor Rollback unbekannte Versandzustände
   prüfen: ältere Worker kennen die neue Recovery-Semantik nicht vollständig.

Bereits offene AI-Sendefreigaben müssen erneut geprüft werden: Die Freigabe bindet
nun auch zusätzliche Anhangsmetadaten. Bestehende HttpOnly-Anmeldesitzungen bleiben
benutzbar; alte im Browser gespeicherte Bearer-Tokens werden beim Laden entfernt.
Native Clients und dedizierte MCP-Schlüssel behalten ihr serverseitiges Protokoll.

## Grenzen

- Echte iPhone/Safari-Nutzung, externe Zustellung und sämtliche Drittanbieterpfade
  sind durch lokale Chromium-/Fehlersimulationen nicht vollständig nachgewiesen.
- Die neue Queue-Karte zeigt aufgezeichnete Endfehler der letzten sieben Tage,
  keine aktuelle DLQ-Größe oder Garantie, dass jeder Datenbankausfall protokolliert
  werden konnte. Sie liest höchstens 101 Meldungen und zeigt fünf letzte Phasen.
- Unsichere unmittelbare Sendungen werden vor automatischer Wiederholung
  geschützt und im Fehlertext erklärt; eine eigene zentrale Klärungsoberfläche
  dafür ist nicht Teil dieses Releases.
- Bestehende Webhook-Zustellung behandelt einzelne Fehler intern. Vollständige
  Exactly-once-Zustellung von Webhooks wird nicht behauptet; Mailversand wird
  wegen eines Webhook-Fehlers nicht wiederholt.
- Cloudflare-Buildtrigger und GitHub-Branchschutz sind externe Einstellungen.
  Der verfügbare Token erlaubt keine Prüfung der Builds-Trigger. Der reguläre
  `npm run build` enthält deshalb selbst die statische Qualitätsfreigabe.
- Registry meldet weiterhin moderate Einträge im Entwicklungs-Lintwerkzeug;
  konkrete Einordnung und Wiedervorlage in [security-dependencies.md](security-dependencies.md).
- Der Bundler meldet weiterhin Hinweise zur gültigen CSS-Highlight-Syntax und
  zu fehlenden Sourcemaps in zwei Framework-Plugins. Diese Hinweise sind nicht
  unterdrückt; der gebaute Worker und die betroffenen Browserabläufe werden
  zusätzlich ausgeführt.

## Zusätzliche Befunde aus den externen Prüfläufen

- Cloudflare führte alle 791 Tests aus; der verschlüsselte Restore-Rundlauf
  scheiterte am fehlenden Python-Paket `cryptography`. `npm test` richtet nun eine
  isolierte Python-Umgebung ein und installiert die festgelegten, per SHA-256
  geprüften Wheels aus `scripts/requirements-recovery.txt`. Voraussetzung sind
  Python 3.10+ mit venv/pip und beim ersten Lauf Zugriff auf PyPI. Systempakete
  werden nicht verändert. Der Wiederherstellungstest bleibt Bestandteil der
  Freigabe.
- Der GitHub-Browserlauf deckte eine echte PDF-Kompatibilitätslücke auf: PDF.js
  6.4.299 verwendet im Standardbuild `Map.getOrInsertComputed`, das Chromium 143
  und ältere iPhone-Browser noch nicht besitzen. Mit gezielt entfernten Methoden
  in Browser und PDF-Worker ist der Fehler reproduziert; die zusammengehörigen
  offiziellen Legacy-Builds rendern dieselbe dreiseitige Datei einschließlich
  geprüfter Randpixel. Renderer und Worker bleiben auf derselben Paketversion
  und werden erst beim Öffnen eines PDFs geladen.
  Die fertige App besteht den Anhangstest bei 320, 390, 844 und 1440 px;
  bei 320 px sind die neueren Methoden in beiden Ausführungskontexten absichtlich
  entfernt. Zoom, vollständige Seiten, Download, Bilder und Fehlerwiederholung
  werden ebenfalls geprüft. Auch der vollständige Build ist mit allen
  791 gewöhnlichen Tests erneut erfolgreich.
- Die Browser-CI verwendet Ubuntu 24.04 passend zum installierten Playwright
  1.57. Ohne expliziten lokalen Browserpfad wählen alle Tests dessen mitgelieferten
  Chromium. Fehlerauszüge und Browserprotokolle werden als CI-Nachweise erhalten.

## Verifizierte Ergebnisse

- Vollständige gewöhnliche Suite: **791 Tests bestanden**, keine Fehler oder
  übersprungenen Tests (vorher 722 von 734 bestanden).
- TypeScript ohne Fehler; ESLint ohne Fehler oder Warnungen (vorher 15 Typfehler,
  58 Lintfehler und 72 Warnungen).
- Zusätzlich echter lokaler Produktions-Worker mit D1: Anmeldung über die
  Oberfläche, beide Secure/HttpOnly/SameSite-Cookies, Cookie-API-Zugriff, Neuladen
  nach Löschen des lokalen Speichers und Abmeldung mit anschließendem HTTP 401
  bestanden. Keine simulierten Login-Antworten und keine externen Mailaktionen.
- Produktionsabhängigkeiten: Registry-Audit ohne gemeldete Schwachstellen;
  gesamter Audit ohne kritische/hohe Meldungen. Die 16 moderaten Einträge des
  Entwicklungs-Lintwerkzeugs bleiben gesondert dokumentiert.
- Alle neun Browser-Suites auf dem finalen Build bestanden: Darstellung,
  Anhänge, Verfassen/AI, Labels, Sternfehler, Entwurfswiederherstellung,
  Hintergrundstatus, Loginvarianten und echte Cookie-Sitzung. Desktop, kleine
  Mobilansichten und Dark Mode wurden zusätzlich anhand der Screenshots geprüft.
- Haupt-Stylesheet von 143.629 auf **137.001 Bytes** reduziert: Test-Fixtures
  erzeugen keine produktiven Utilities mehr; 148 nirgends verwendete Farbvariablen
  entfernt. Alle 85 verwendeten Farbwerte unverändert. Eine zusätzliche
  Buildprüfung schützt die Farbdeckung auch für verzögert geladene Stylesheets.
  Das bisherige CSS-Budget bleibt bei 140.000 übertragenen Bytes im lokalen
  unkomprimierten Browser-Test.
- Kontrollierter Browser-Performancetest bestanden: je drei kalte und warme
  Durchläufe bei 390/1440 px, 100 ms Netzlatenz und vierfach gedrosselter CPU.
  CSS-Transfer kalt 137.295 Bytes; vorhandene Budgets für JavaScript, Requests,
  Layoutstabilität und erstes Öffnen einer Mail ebenfalls eingehalten.
  Gemessener Reader-p75: mobil kalt 1,15 s/warm 0,48 s, Desktop kalt 0,86 s/warm
  0,63 s. Synthetische 100-ms-APIs und unkomprimierte lokale Auslieferung: kein
  Feld-p75, kein neuer Produktionslatenznachweis und keine garantierte Zeit auf
  einem echten iPhone. Der separate Navigationsbenchmark mit 60.000 synthetischen
  Nachrichten wurde ebenfalls erfolgreich ausgeführt.
