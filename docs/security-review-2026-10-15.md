# Mailflare: Sicherheits- und Datenschutzprüfung vom 15. Oktober 2026

Diese Prüfung umfasst den Anwendungscode, ausgewählte Zugriffstests mit isolierten Testkonten und lesende Cloudflare-Konfigurationsabfragen. Es wurden keine produktiven E-Mail-Inhalte oder Zugangstoken zur Prüfung ausgegeben. Sie ist kein Penetrationstest aller Schnittstellen und keine rechtliche DSGVO-Zertifizierung.

## Ergebnis und behobene Punkte

Ein vollständiger Schutz gegen jeden Zugriff kann nicht zugesagt werden. Die geprüften Nachrichten- und Anhang-Endpunkte trennen Postfächer nach Eigentum bzw. expliziten Freigaben. Berechtigte Betreiber mit Datenbank-/Cloudflare-Zugriff können Inhalte technisch lesen: Mailflare hat keine Ende-zu-Ende-Verschlüsselung.

| Befund | Maßnahme |
| --- | --- |
| Ältere Sitzungscookie-Routen akzeptierten Änderungen aus fremden Origins. Im Test konnten ein Label angelegt und die Sitzung abgemeldet werden. | Gemeinsame Authentifizierung prüft bei Cookie-Schreibzugriffen den Origin. Abmeldung und Kontowechsel sind ebenfalls abgesichert. Bearer-API-Zugriffe und normale Bedienung bleiben möglich. Regressionstests prüfen, dass keine Datensätze verändert werden. |
| Worker-Observability speicherte Aufrufe mit URL-Parametern. Suchbegriffe, Adressen und OAuth-Codes können in solchen URLs stehen. Fehlerobjekte können SQL-Parameter enthalten. | Query-Redaktion aktiviert, automatische Invocation-Logs und persistente Worker-Logs/Traces deaktiviert. Fehler im Mail-Eingang/Queue-Pfad werden auf Fehlerkategorien reduziert. Bereits gespeicherte historische Logs werden dadurch nicht rückwirkend gelöscht. |
| Die Paketprüfung meldete kritische und weitere Sicherheitswarnungen. | Next.js auf 16.3.8, betroffene 7.x-undici-Abhängigkeiten auf 7.29.1, source-map-js auf 1.2.2, sharp 0.35.4 auf 0.35.5 und fflate 0.7.x auf 0.7.5 aktualisiert. Danach: keine kritischen oder moderaten Warnungen; sieben hohe Meldungen stammen aus der verbleibenden braces-Abhängigkeit und ihren Build-/Glob-Abhängigkeiten. Siehe unten. |
| Der authentifizierte Browser-Fetch hing Sitzungstoken auch an beliebige Ziel-URLs an. Es wurde kein aktueller externer Aufruf damit festgestellt. | Zusätzliche Schranke: authentifizierte Aufrufe dürfen nur zur eigenen Origin gehen. Tests prüfen auch URL- und Request-Objekte. |
| Der Datenbankexport las ganze Tabellen und serialisierte anschließend das gesamte Archiv im Arbeitsspeicher. | Hintergrundexport mit kleinen D1-Abfragen, festen 5-MiB-R2-Teilen, gespeicherten Checkpoints, Lease gegen Doppelverarbeitung und automatischer Wiederaufnahme. Migration 0078 ergänzt nur die bestehende Backup-Tabelle. |

Die npm-Empfehlung für die verbleibende `braces`-Warnung würde Vinext auf eine ältere inkompatible Version umstellen. Das wurde nicht blind ausgeführt. Der neueste stabile braces-Stand 3.0.3 ist selbst betroffen (GHSA-vfj7-8cjw-p6xm). Die betreffenden Glob-Werkzeuge werden für den Build verwendet; ein vom Nutzer erreichbarer Glob-Eingabepfad wurde hier nicht festgestellt. Ein bereinigtes Upstream-Update bleibt offen. Paketwarnungen sind keine Feststellung eines erfolgten Angriffs.

## Tatsächlich geprüfte Cloudflare-Einstellungen

- R2 `mailflare-raw`: verwaltete öffentliche r2.dev-Adresse deaktiviert, keine eigenen öffentlichen Bucket-Domains.
- R2-Standort `EEUR`, Jurisdiction `default`; D1-Ausführungsregion `EEUR`, Jurisdiction nicht gesetzt. Das ist **keine verbindliche Zusage ausschließlicher EU-Speicherung oder EU-Verarbeitung**. Workers und KI haben in dieser Konfiguration keine nachgewiesene EU-Beschränkung.
- Ein aktives Mailflare-Konto; MFA für dieses Konto und den Hauptadministrator aktiviert. Keine delegierten Postfachberechtigungen und keine API-Schlüssel vorhanden.
- Keine ausgehenden Mail-Webhooks und keine Konto-Weiterleitung konfiguriert.
- Keine öffentlichen Drive-Freigaben. Ein aktiver zeitlich begrenzter Anhang-Link besteht. Wer den vollständigen Link kennt, kann den einzelnen freigegebenen Anhang abrufen; damit wird nicht die Mailbox öffentlich. Der Link wurde nicht widerrufen.
- Automatische Datenbankbackups und Löschung nach 30 Tagen sind eingeschaltet. Sie sichern Datensätze und Objektverweise, nicht zusätzlich den Inhalt aller Anhänge/Rohmails im R2-Bucket. Für deren Wiederherstellung muss der Objektspeicher erhalten bleiben bzw. separat gesichert werden.
- Anonyme Aufrufe der Workers-Subdomain und ihrer Nachrichten-/Backup-Pfade wurden zu Cloudflare Access umgeleitet. Die eigene Mail-Domain konnte aus dieser Arbeitsumgebung nicht direkt geprüft werden; ihre Anwendungsberechtigungen wurden in isolierten Tests geprüft. Access wurde nicht umgangen.
- MFA und Mitarbeiter-/Token-Berechtigungen des Cloudflare-Kontos konnten mit dem verfügbaren API-Token nicht vollständig geprüft werden. Das muss der Kontoinhaber im Dashboard kontrollieren.

## Datenverarbeitung und Empfänger

| Verarbeitung | Welche Daten werden verwendet? | Einordnung |
| --- | --- | --- |
| Cloudflare Workers, Queues, D1, R2 | E-Mail-Inhalte, Header, Empfänger/Absender, Anhänge, Profilbilder, Datenbankbackups; Queues enthalten u. a. Objektverweise und Adressen. | Cloudflare ist technischer Auftragsverarbeiter. Plattformverschlüsselung ersetzt keine Ende-zu-Ende-Verschlüsselung. |
| Automatische Kategorisierung | Clef Flash über Workers AI: Absender/Empfänger, Betreff, bis zu 6.000 Zeichen sichtbarer Inhalt sowie passende Korrekturbeispiele und technische Signale. | Inhalte werden für die KI-Verarbeitung übertragen. Keine reine lokale Verarbeitung im Browser. |
| KI-Assistent, Zusammenfassung, Übersetzung | Ausgewählte Inhalte bzw. Nachrichten aus dem zugelassenen Postfach. Der gespeicherte Anbieter ist Cloudflare, Modell `moonshotai/kimi-k3`; kein separater externer Anbieter-Schlüssel ist gespeichert. | Modellbedingungen, Unterauftragsverarbeiter und Verarbeitungsregionen müssen zu den verwendeten Daten passen. |
| Unbekannte Absenderbilder | Gravatar erhält einen SHA-256-Hash der normalisierten E-Mail-Adresse; Google-Favicon-Abfragen erhalten die Absender-Domain. Bilder werden zwischengespeichert. | Hashes von E-Mail-Adressen sind pseudonyme Daten, keine garantierte Anonymisierung. Bekannte mitgelieferte Logos brauchen diese Abfrage nicht. |
| Externe Bilder in E-Mails | Der Browser lädt Bilder direkt vom jeweiligen Anbieter. Referrer werden unterdrückt, IP-Adresse und Abrufzeit bleiben beim Ziel sichtbar. | Gemäß der gewünschten Einstellung derzeit zugelassen; Tracking-Pixel können Öffnungen erkennen. Unter Einstellungen → Posteingang → Externe Inhalte deaktivierbar. |
| Paperless | PDFs werden bei entsprechender Label-Aktion an die konfigurierte DMS-Instanz über HTTPS übertragen. API-/Access-Zugangsdaten sind zusätzlich mit AES-GCM und einem Worker-Secret verschlüsselt. | Bewusst aktivierte Integration; keine allgemeine Freigabe der Mailbox. |
| Web Push | Verschlüsselte Benachrichtigungen über die jeweiligen Browser-/Geräte-Pushanbieter. | Nachrichtenvorschauen können auf dem Gerätesperrbildschirm sichtbar werden. |

Cloudflare beschreibt, dass Workers-AI-Kundeninhalte anderen Kunden nicht bereitgestellt und ohne ausdrückliche Zustimmung nicht für Modelltraining oder Serviceverbesserung verwendet werden. Das ersetzt weder die Prüfung der Modellbedingungen noch eine EU-Standortzusage:
https://developers.cloudflare.com/workers-ai/platform/data-usage/

## Verbleibende Datenschutz- und Betriebsaufgaben

1. AVV/DPA mit Cloudflare, aktuelle Unterauftragsverarbeiter, Drittlandtransfers und ggf. SCC/TIA dokumentieren. Rechtsgrundlage und Datenschutzhinweise für Geschäftsmails, Kontakte und KI-Verarbeitung festlegen. Vertragsannahmen wurden nicht nachgewiesen.
2. Falls ausschließlich EU-Verarbeitung vorgeschrieben ist, eine konkrete EU-Architektur für R2, D1, Workers **und** KI planen. Die vorhandenen Standorthinweise erfüllen diese Anforderung nicht allein; eine Migration würde Daten und Betrieb betreffen und wurde nicht ungefragt durchgeführt.
3. Der aktive Sitzungstoken wird weiterhin im Browser-LocalStorage gehalten. Dadurch könnte erfolgreich eingeschleustes JavaScript bzw. eine berechtigte Browser-Erweiterung ihn lesen. E-Mail-HTML wird bereinigt und getestet, trotzdem bleibt eine Umstellung auf reine HttpOnly-Sitzungen eine sinnvolle weitere Härtung. Die aktuelle CSP erlaubt Inline-Skripte und Eval; eine Nonce-basierte Umstellung muss mit dem Framework getestet werden.
4. Aufbewahrungsfristen für Anmelde-/Auditdaten (einschließlich IP und User-Agent), Nachrichten, KI-Verläufe, Roh-Importdateien und Freigabelinks festlegen. Ein globaler zeitgesteuerter Löschlauf für sämtliche Audit-/KI-Daten wurde nicht nachgewiesen.
5. Cloudflare-Konto mit MFA, minimalen Rollen und eng begrenzten API-Token betreiben. Zugang zum Betreiberkonto ermöglicht trotz geschützter Web-Oberfläche Zugriff auf gespeicherte Daten.
6. Die neue Backup-Ausgabe bleibt kompatibles Version-1-JSON. Die bestehende Browser-Wiederherstellung lädt eine Datei weiterhin vollständig ein und ist für sehr große Backups weiterhin gesondert zu berücksichtigen. Ein großer produktiver Restore wurde wegen seiner destruktiven Wirkung nicht ausgeführt. Laufende Tabellenexporte sind außerdem kein atomarer Point-in-Time-Snapshot aller Tabellen; für eine solche Wiederherstellung sind D1 Time Travel bzw. koordinierte Schreibpausen relevant.

## Prüfung

Die zugehörigen Tests umfassen Postfachtrennung (auch gegenüber fremden Administratoren), gesperrte Konten, widerrufene Freigaben, geschützte Anhänge und Originalnachrichten, Cookie-CSRF, Kontowechsel, ausstehende Antworten nach Kontowechsel, HTML-Bereinigung sowie Backup-Wiederaufnahme, Multipart-Teilgrößen und kompatible Wiederherstellung in einer isolierten Datenbank. Reale produktive Mailinhalte wurden dafür nicht benötigt.
