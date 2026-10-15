# Ladewege der Hauptmenüs

Die Änderungen optimieren Datenabrufe und Codeaufteilung. Klassen, Abstände, Menüstruktur, Animationen und erreichbare Funktionen bleiben gleich.

## Geprüfte Bereiche

- Posteingang, Kategorien und Leser: echter Produktions-Router, erster Klick, schnelle Folgeauswahl, Zurück, Fehler/Wiederholung, Checkbox/Stern/Archivieren und vollständige klickbare Zeilen.
- Suche: bestehende 250-ms-Eingabebündelung und FTS5-Abfragen; Filter- und Lesebereichstests.
- Einstellungen: alle acht Seiten, mobile Navigation, kurze Bildschirme, große Schrift, Fokus, Abschnitt-Links und erhaltene Formulareingaben.
- Administration: Übersicht und Domainliste; die Navigationstestdatei besucht außerdem die übrigen administrativen Hauptmenüs.
- Drive: eigener Bereich, Metadaten/Freigaben, Ordnerhierarchien, Kontowechsel und verspätete Antworten.
- Kalender: Wechsel über das Profilmenü, vorhandene zeitlich eingegrenzte Ereignisabfrage und memoierte Wiederholungsexpansion.

## Messung

Der Browser verwendet den tatsächlichen Vinext-/Cloudflare-Produktionsbuild und echte Navigation. Private APIs liefern synthetische Daten nach 100 ms. Chromium startet mit leerem Cache, vierfacher CPU-Drosselung, 100 ms Netzwerklatenz und 1,5 MB/s Downloadrate. Die Uhr für Bildschirmvergleiche ist fixiert; übertragene JavaScript-Bytes werden deshalb direkt über das Chrome DevTools Protocol erfasst.

| Erster Aufruf | JavaScript vorher | JavaScript nachher | Automatisch vorgeladene fremde Seiten vorher/nachher |
| --- | ---: | ---: | ---: |
| Konto, Desktop | 1.761.032 Bytes | ca. 1.176.000 Bytes | 8 / 0 |
| Posteingangs-Einstellungen, Desktop | 1.341.454 Bytes | ca. 1.174.000 Bytes | 8 / 0 |
| Konto, 390 Pixel | 1.655.986 Bytes | ca. 1.176.000 Bytes | 2 / 0 |
| Posteingangs-Einstellungen, 390 Pixel | 1.655.986 Bytes | ca. 1.174.000 Bytes | 2 / 0 |

Die kontrollierten Erstaufrufe lagen vorher bei rund 4,3–4,8 Sekunden, danach bei rund 4,0–4,2 Sekunden. Die Aussage über die Datenmenge ist belastbarer als der Zeitvergleich einzelner Durchläufe. Die Mehrheit der getesteten Einstellungswechsel lag bei etwa 0,5–0,65 Sekunden einschließlich einer bewussten Testwartezeit von 250 ms. Erstmals gewählte Bereiche laden ihre eigenen Module beim Aufruf; unbesuchte Ziele erzeugen dafür keine Hintergrundlast mehr. Es wird nicht behauptet, jeder einzelne erste Klick sei schneller als bei bereits vorab geladenen Zielseiten.

In vier vollständigen Vorher-/Nachher-Bildschirmvergleichen (Konto/Posteingangs-Einstellungen bei 1440 und 390 Pixel) gab es **null abweichende Pixel**. Die Bildschirmdateien liegen im lokalen Prüfbereich, nicht als persönliche Daten im Repository.

Die angemeldete Produktionsoberfläche hinter Cloudflare Access war hier nicht zugänglich. Browserzeiten sind keine Messung der persönlichen produktiven Sitzung. Frühere produktive D1-Abfragemessungen stehen in `startup-query-review-2026-10-15.md`; die dort korrigierte Label-Auswertung sank von 3.951 ms auf 126–250 ms. Die bereits geprüften Cloudflare-Einstellungen Brotli, HTTP/3 und Early Hints bleiben aktiv. Persönliches HTML und Mail-JSON bleiben `private, no-store`.

## Änderungen

1. Konto- und Posteingangs-Einstellungen laden umfangreiche geschlossene Formulare erst beim ersten Öffnen. Insbesondere der Signatur-Editor, Profilbearbeitung, Spam-/KI-Einstellungen und Paperless gelangen nicht mehr in den kritischen Startpfad. Besuchte Formulare bleiben beim Einklappen montiert. Sprache und Erscheinungsbild bleiben direkt erreichbar.
2. Einstellungen, Profilmenü, Kalender, Drive und administrative Übersicht laden keine vollständigen fremden Routen allein wegen sichtbarer Links. Bereits besuchte Seiten und bestehende gezielte Nachrichten-Vorladung behalten ihre Nutzung.
3. Seitenleiste und Label-Menüs teilen Ordnerdefinitionen und laufende Abrufe. Änderungen invalidieren den Cache, erfolglose Antworten werden nicht gespeichert, Ergebnisse verfallen nach 30 Sekunden und Kontowechsel trennen die Daten.
4. Konto-/Profil- und administrative Metadaten nutzen die gerade geprüfte Sitzung, statt zusätzliche identische Anmeldeabfragen zu starten. Zugriffsprüfungen der APIs bleiben unverändert.
5. Die Domainliste rendert gespeicherte Daten vor dem DNS-Audit. Eine absichtlich zurückgehaltene DNS-Antwort blockiert weder Liste noch Navigation. Der Audit läuft separat und aktualisiert dieselben Statusanzeigen nach Eingang.
6. Drive bündelt Besitzer-/Freigabemetadaten mit maximal 80 Parametern je Statement und maximal 25 Statements je Batch. Ein Test mit 1.000 Dateien und 260 Besitzern benötigt zwei begrenzte Metadaten-Roundtrips und behält Namen, Freigabestatus und geschützte Link-Tokens korrekt bei. Die bisherige Besitzerabfrage konnte zudem D1s Parameterlimit überschreiten.
7. Drive prüft Hierarchien gesammelt nach Tiefe. Für 200 Elternordner mit Dateien waren vier statt einzelner Abfragen pro Ordner nötig. Gelöschte Vorfahren bleiben verborgen, Berechtigungen werden weiter live geprüft.
8. Der schnelle Drive-Ordnercache wird bei Kontowechseln und Änderungen verworfen. Ein Abruf speichert seine Cache-Revision beim Start; verspätete Antworten dürfen weder Daten eines vorherigen Kontos noch inzwischen ungültige Ordnerstände wieder eintragen.
9. `Server-Timing` zeigt jetzt auch bei Domain- und Drive-Listen die Dauer der Authentifizierung und Datenverarbeitung. Die Header enthalten keine E-Mail-Inhalte oder Zugangsdaten.

## Wiederholbare Prüfung

Nach `npm run build` führt `npm run test:performance` die Funktionsprüfungen, den Kaltstart-/Leser-Test und die Navigation mit dem Produktions-Router aus. Falls erforderlich, Playwright über `MAILFLARE_PLAYWRIGHT_MODULE` und Chromium über `MAILFLARE_CHROMIUM_EXECUTABLE` angeben. Tests starten/beenden nur ihre eigenen Previews.

Die Budgetgrenzen betragen 1,35 MB Start-JavaScript für die Mailbox und 1,25 MB für geschlossene Konto-/Posteingangs-Einstellungen. Weitere Assertions sichern genau einen anfänglichen Identitäts-/Ordnerabruf, ausbleibende automatische Routen-Vorladung, lazy geladene Formulare, Erhalt von Eingaben und bedienbare Domains trotz laufendem DNS-Audit ab.

Die globale Typprüfung hat unverändert die bekannten 15 Fehler; keine neuen Typfehler. Neue Backend-/Cache-/Lazy-Loading-Module werden zusätzlich gezielt mit ESLint geprüft.
