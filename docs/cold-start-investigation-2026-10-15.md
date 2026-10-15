# Kaltstart und erster Nachrichtenklick

## Reproduktion

Geprüft wurde der echte Vinext-/Cloudflare-Produktionsbuild mit dem echten Browser-Router. Nur die privaten APIs liefern synthetische Benutzer-, Postfach- und Nachrichtendaten. Die Tests lesen keine produktiven E-Mail-Inhalte. Chromium läuft mit leerem Cache, vierfacher CPU-Drosselung, 100 ms Netzwerklatenz und 1,5 MB/s Downloadrate auf 390 und 1440 Pixel Breite. Die Fixture-APIs antworten nach 100 ms.

Die alte Fassung erzeugte bis zum ersten geöffneten Leser 231 bzw. 238 Anfragen. Automatische Link-Vorladung startete dabei auch andere Ordner und die Label-Einstellungen. Geschlossene Editoren und der KI-Assistent brachten ihre Abhängigkeiten in den Startpfad. Die kritischen JavaScript-Ressourcen der initialen HTML-Antwort umfassten im lokalen Test rund 1.865.517 übertragene Bytes.

Ein absichtlich abgebrochener erster Nachrichtenabruf reproduzierte einen zweiten Fehler: Der Browser meldete `Failed to fetch`, der Lesebereich blieb auch nach vier weiteren Sekunden in seinem Ladezustand. Der asynchrone Abruf wurde nicht abgefangen. Fehlerantworten konnten außerdem als vermeintlich erfolgreiche Details im Cache bleiben. Ein erneuter Klick auf dieselbe ausgewählte Nachricht führte nur zu einer Navigation auf dieselbe URL; dadurch startete ihr an die Nachrichten-ID gebundener Ladeeffekt nicht neu.

Das ist eine Reproduktion mit kontrollierten Ausfällen und dem echten Produktions-Router. Die vom Benutzer beobachtete Minute wurde in seiner angemeldeten produktiven Sitzung nicht direkt nachgemessen. Die Ergebnisse sind keine Garantie für bestimmte Ladezeiten bei jeder Verbindung; insbesondere produktive Authentifizierung, Datenbanklatenzen und Geräte unterscheiden sich von dieser Umgebung.

## Änderungen

- Der Editor wird erst beim Schreiben geladen. Der KI-Assistent lädt seine aufwendigen Ansichten erst beim Öffnen und behält anschließend seinen Zustand. Die erste Nachricht an den noch ladenden Assistenten wird als Prop übergeben und geht nicht als verfrühtes Browser-Ereignis verloren.
- Ordner, Kategorien und Nachrichten laden keine vollständigen fremden Seiten allein wegen ihrer Sichtbarkeit vor. Bestehende gezielte Datenvorladung für Kategorien bleibt bestehen. Nachrichten werden bei Fokus, Berührung oder nach 120 ms Hover vorbereitet; beim Klick startet der Detailabruf parallel zur Seitennavigation. Vorbeifahrender Mauszeiger wird wieder abgemeldet.
- Ein früher Klick bestätigt die Auswahl sofort mit dem Betreff und einer Ladeansicht im bestehenden Lesebereich. Die Nachrichtenliste bleibt erhalten. Schnelle Folge-Klicks, verspätete Antworten und Zurück während einer offenen Navigation sind geprüft.
- Fehlerhafte HTTP-/JSON-Antworten werden nicht als erfolgreiche Nachricht gecacht. Der Detailabruf ist auf 30 Sekunden begrenzt. Fehlgeschlagene Abrufe bieten Wiederholen an, statt unbegrenzt zu laden. Auch ein erneuter Klick auf die bereits ausgewählte Nachricht kann ihren Abruf wiederholen. Für eine über 15 Sekunden ausstehende Seitennavigation gibt es zusätzlich einen direkten Link zum erneuten Öffnen.
- Die Anmeldung schützt die Oberfläche unverändert; nach ihrer Bestätigung entfällt die künstliche Mindestwartezeit der Startanimation. Der Zugriffsschutz der APIs und die privaten Cache-Regeln bleiben erhalten.

In den isolierten Nachher-Läufen wurden vor dem ersten Klick etwa 1,24 MB JavaScript geladen, ungefähr ein Drittel weniger. Die Auswahl wurde nach wenigen Zehn Millisekunden sichtbar bestätigt, während der Test die eigentliche Router-Antwort noch zurückhielt. Diese Einzelmessungen sind keine stabilen Geräte-Benchmarks. Das Ausbleiben unerwünschter Vorladeanfragen, der parallele Datenabruf und das Fehler-/Wiederholungsverhalten werden direkt geprüft.

## Prüfung

`tests/browser/cold-start.mjs` startet bei Bedarf einen eigenen lokalen Produktions-Preview. Es prüft Handy und Desktop mit gedrosseltem Browser, die erste Assistentenanfrage nach verzögertem Laden, schnelle Folge-Klicks, Zurück vor der ersten Router-Antwort, den zeitgesteuerten Wiederholungslink, Transportfehler mit erfolgreicher Wiederholung sowie das erste Öffnen/Schließen des verzögert geladenen Editors. Es beendet nur den selbst gestarteten Preview.

Weitere Regressionstests prüfen Sitzungstrennung, ausstehende Antworten nach Kontowechsel, gemeinsame Detailabrufe, erhaltene Listen-/Lesebereich-DOM-Knoten, Filter und Auswahl, Gelesen-Zähler, Wischen und Aktualisieren. Die globale Typprüfung hat weiterhin die bereits bekannten 15 Fehler außerhalb dieser Änderung; neue Typfehler wurden nicht festgestellt.

Der finale Produktionsbuild ist erfolgreich. 49 Funktionstests, acht Fälle mit dem echten Produktions-Router und 29 bestehende Browser-Regressionsfälle sind erfolgreich. ESLint für die neuen/deutlich überarbeiteten Lade- und Fehlerkomponenten meldet keine Fehler; der bestehende Hinweis zum Branding-`img` bleibt bestehen. Dies ist kein vollständig fehlerfreier globaler Typ-/Lint-Lauf.
