# Nachrichtenabruf und PDF-Vorschau

## Kurzzeitige Fehler beim Öffnen

Die produktiven HTTP-Analytics für `mail.steffenvonlindern.de` zeigen am 15. Oktober 2026 um 14:20–14:21 UTC sieben leere HTTP-500-Antworten für einzelne Nachrichten. Auch zwei Navigationsabrufe und zwei Auftragsstatus-Abfragen schlugen fehl. Ab 14:22–14:23 UTC wurden wieder erfolgreiche Nachrichtenabrufe erfasst, darunter eine zuvor betroffene Nachricht. Der Nutzer bestätigte anschließend, dass sich die E-Mail wieder öffnen lässt.

Beide betroffenen Nachrichten existieren. Der tatsächliche Nachrichten-Lesehelfer konnte ihre Daten über lesende D1-Verwaltungsabfragen und ihre MIME-Header über die authentifizierte R2-Verwaltungs-API laden. Inhalte wurden dabei nicht in Diagnoseausgaben geschrieben. Der lokale Produktionsserver beantwortete nach Aktualisieren seiner lokalen Migrationen authentifizierte Detail-, Listen-, Navigations- und Auftragsstatus-Anfragen einschließlich paralleler Abrufe erfolgreich. Hierfür wurde ausschließlich eine vorübergehende lokale Testsitzung verwendet und anschließend entfernt; produktive Sitzungen wurden weder angelegt noch ausgelesen.

Eine genaue Serverausnahme wurde nicht ermittelt: Die produktive Konfiguration speichert keine Worker-Logs dauerhaft und der WebSocket-Zugang für Live-Tails wurde von der Arbeitsumgebung abgelehnt. SQL-Insights erfassten in dem untersuchten Fenster keine Abfragefehler; die Worker-Metriken zeigten keine Ressourcenlimit-Ausnahme. Damit ist ein vorübergehender API-Fehler belegt, keine eindeutige interne Ursache. Diese Änderung wird nicht als Behebung einer nachgewiesenen Serverursache dargestellt.

Der Detailabruf wiederholt HTTP 500/502/503/504 sowie vorübergehende Verbindungsfehler jetzt höchstens zweimal, nach 350 und 1.000 ms. Alle Versuche teilen das bisherige Zeitbudget von 30 Sekunden. Vorladen, Klick und Leser teilen weiterhin eine Anfrage einschließlich ihrer Wiederholungen. Dauerhafte Berechtigungs-/Nicht-gefunden-Antworten, ausdrückliche Abbrüche und ungültige Nachrichtendaten werden nicht wiederholt. Ein Kontowechsel oder das Leeren des Detailcaches beendet weitere Wiederholungen; alte Antworten können den neuen Cache nicht befüllen. Schreibaktionen werden nicht wiederholt.

## PDF-Vorschau

Die eingebettete native PDF-Ansicht wurde durch einen lokal im Browser laufenden PDF.js-Renderer ersetzt. Damit hängt die Seitenbreite nicht mehr vom PDF-Plugin des iPhones ab. Unter 1.024 Pixeln füllt der Dialog den verfügbaren dynamischen Viewport; seine kompakte Kopfzeile enthält Dateiname, Download und Schließen. Sicherheitsabstände des Geräts werden berücksichtigt. Auf größeren Bildschirmen bleibt eine große Dialogansicht.

Die Standardansicht zeigt die ganze Seitenbreite. Alle Dokumentseiten, auch gedrehte und querformatige Seiten, sind durch Scrollen erreichbar. Zoom und Zurücksetzen auf Seitenbreite stehen zur Verfügung. Nur Seiten in der Nähe des sichtbaren Bereichs werden gerendert; entfernte Canvas-Puffer werden freigegeben und die Auflösung großer/vergrößerter Seiten ist begrenzt.

PDF.js, Worker und Hilfsdateien werden erst beim Öffnen eines PDFs geladen. Fonts, Zeichentabellen und Decoder stammen vom eigenen Ursprung und haben zur Paketversion passende unveränderliche Asset-Pfade. Dokumente gehen an keinen externen Betrachter. Anhänge werden weiterhin authentifiziert und mit `private, no-store` ausgeliefert; die PDF-Ansicht lädt sie ebenfalls ohne HTTP-Cache. XFA ist deaktiviert; es wird kein PDF-Scripting-Betrachter eingebunden.

## Prüfung

`tests/account-switch.test.mjs` prüft die begrenzte Wiederholung leerer 500-Antworten, Verbindungsfehler, dauerhafte Fehler, manuelle Erholung, Deduplizierung und einen Kontowechsel während der Wartezeit. `tests/browser/attachment-preview.mjs` verwendet den tatsächlichen Produktionsbuild, Router, PDF-Renderer und Worker mit synthetischen privaten API-Antworten. Er öffnet eine Nachricht nach Beginn des Ordner-Vorladens, provoziert einen leeren HTTP-500-Fehler und prüft die automatische Erholung.

Die PDF-Fälle laufen bei 320×700, 390×844, 844×390 und 1440×900 Pixeln. Ein dreiseitiges Dokument enthält normale, querformatige und gedrehte Seiten. Pixelprüfungen sichern tatsächlich gerenderte linke, rechte und untere Seitenränder ab; hinzu kommen Größenprüfung, Zoom, Download, Schließen, Orientierungwechsel und Wiederholung einer fehlgeschlagenen PDF-Anfrage. Der Performance-Prüflauf enthält beide neuen Fälle sowie die bisherigen Kaltstart-, Kategorie-, Vorlade- und Menütests.

Viewport-Prüfungen in Chromium ersetzen keine Prüfung auf einem physischen iPhone. Der produktive Zugriff hinter Cloudflare Access wurde nicht umgangen; synthetische Browserwerte werden nicht als Messung der persönlichen produktiven Sitzung ausgegeben.
