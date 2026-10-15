# Postfächer nach dem Start vorladen

Nach dem Anzeigen der aktuellen Nachrichtenliste lädt Mailflare die anderen Mailbereiche gestuft vor. „Alle E-Mails“ kommt zuerst, danach Rechnung, Werbung, soziale Medien, Bestellung und die übrigen Systemordner. Anschließend werden die Labels berücksichtigt.

Pro Ordner wird die erste Listenseite mit höchstens 25 Einträgen geladen. Dieselben Abfrageparameter und derselbe Cache werden auch von der normalen Navigation verwendet, einschließlich Konversationsansicht, Postfach und Zeitzone. Ganze Nachrichteninhalte, Anhänge und sämtliche Archivseiten werden dabei nicht heruntergeladen. Zusätzlich wird die entsprechende Route vorgeladen; das montiert weder die Seite noch ihre clientseitigen Effekte.

## Vorrang der Bedienung

- Der Vorlauf beginnt erst, wenn die aktuelle Liste fertig geladen ist, kein Suchtext eingegeben wird und weder ein Leser noch eine Sammelaktion aktiv ist.
- Vor der ersten Anfrage wartet er 750 ms Ruhe ab. Tastatur, Tippen und Scrollen verschieben diesen Zeitpunkt. Wenn verfügbar, wird zusätzlich `requestIdleCallback` genutzt; sonst greift ein Timer.
- Es läuft jeweils eine Listenanfrage mit niedriger Browser-Priorität. Laufende Listen- und Zähleranfragen haben Vorrang. Die weiteren Ordner folgen mit kleinen Abständen.
- Eine ausgeblendete oder offline geschaltete App, Datensparen und gemeldete 2G-Verbindungen pausieren die Warteschlange. Sichtbarkeit beziehungsweise Verbindung setzen sie fort.
- Ein Ordnerklick nutzt einen bereits gefüllten Cache oder dieselbe noch laufende Anfrage. Navigation wartet nicht darauf, dass die gesamte Warteschlange fertig ist.

## Frische und Trennung

Vorgeladene Listen liegen ausschließlich im Arbeitsspeicher und verfallen nach zwei Minuten. Nachrichtenänderungen beziehungsweise manuelles Aktualisieren invalidieren sie über die bestehenden Cache-Ereignisse. Geänderte Lesemarkierungen werden auch in bereits vorgeladenen Listen nachvollzogen. Kontowechsel stoppen die Warteschlange, leeren die Caches und verhindern das spätere Speichern alter Antworten; dies wird auch bei einer direkt geänderten Sitzung im Browser-Speicher geprüft.

Fehler beim Vorladen blockieren keine Ansicht. Eine fehlgeschlagene Antwort wird nicht als geladene Liste gespeichert und kann beim normalen Aufruf erneut versucht werden. Die Cache-Regeln für persönliche HTTP-Antworten bleiben `private, no-store`.

## Prüfung

`npm run test:performance` enthält die Ablauf-/Cache-Tests sowie `tests/browser/mailbox-preload.mjs`. Der Browsertest nutzt den tatsächlichen Produktionsbuild und Router mit synthetischen privaten APIs. Er hält die anfängliche Liste absichtlich zurück, prüft das Ausbleiben konkurrierender Vorladeanfragen, einen Klick während einer laufenden „Alle E-Mails“-Anfrage und den ersten Klick nach dem Vorladen aller Ordner samt Label – jeweils bei 1440 und 390 Pixel.

Der Kaltstarttest prüft weiterhin das Start-JavaScript-Budget, eine einzelne anfängliche Listen-/Zähleranfrage, den ersten E-Mail-Klick und ausbleibende Routen-Vorladung vor dem Anzeigen der aktiven Liste. Das nachgelagerte Vorladen anderer Mailordner ist ausdrücklich erlaubt. Die Einstellungen behalten ihr bisheriges bedarfsgesteuertes Laden.

Der Browsertest misst die Reaktion ab dem tatsächlichen Klickereignis. Wartezeiten des Testwerkzeugs auf ein noch animiertes mobiles Menü gehören nicht zu dieser Messung. Beim ersten Besuch der fertig vorgeladenen Ansicht wird kein zusätzlicher Listenabruf erwartet. Die Browserwerte stammen aus dem lokalen Produktionsbuild mit Testdaten; sie sind keine zugesicherte Ladezeit der produktiven Sitzung hinter Cloudflare Access.
