# Mailflare für iOS: Entwurf

Stand: 28. November 2026. Status: zur Freigabe.

## Absicht

Mailflare soll auf dem iPhone eine echte Mail-App sein. Die heutige
Home-Bildschirm-App geht ohne Netz nicht auf und zeigt dann keine einzige Mail,
kann keine Haptik und meldet neue Mails als Web-Mitteilung. Die native App soll
ohne Netz aufgehen und die Mails zeigen, sich wie eine iOS-App anfühlen und
Mitteilungen über iOS selbst bringen. Auf Dauer soll sie alles können, was die
Web-App kann, einschließlich der Einstellungen.

## Ziele

- Die App startet ohne Netz und zeigt die Mails der letzten 30 Tage mit Inhalt.
- Lesen, Sortieren, Schreiben und Senden funktionieren offline; Änderungen
  werden vorgemerkt und beim nächsten Kontakt abgeglichen.
- Native Mitteilungen mit Aktionen und der Zahl ungelesener Mails am Symbol.
- Haptik bei Wischgesten, Senden, Aktualisieren und Fehlern.
- Voller Umfang der Web-App, in vier Blöcken nativ gebaut. Was noch nicht
  nativ ist, öffnet die App als Web-Ansicht.

## Nicht Teil dieses Entwurfs

- Kalender, Terminbuchung, Drive und Verwaltung als native Bildschirme. Sie
  bekommen je einen eigenen Entwurf, wenn sie an der Reihe sind, und sind bis
  dahin als Web-Ansicht in der App erreichbar.
- Ein eigenes iPad-Layout. Die App läuft auf dem iPad, zunächst im iPhone-Aufbau.
- Android, Apple Watch, Widgets, Veröffentlichung im App Store.

## Was nicht passieren darf

- Eine Mail geht doppelt raus, weil ein vorgemerkter Versand wiederholt wurde.
- Eine offline vorgemerkte Aktion geht stillschweigend verloren.
- Die App zeigt offline einen leeren Bildschirm oder eine Fehlerseite.
- Der Schutz der Live-Installation wird schwächer als heute.
- Die Web-App wird langsamer oder teurer, weil die App mitläuft.

## Rahmenbedingungen

- Der Server bleibt der bestehende Cloudflare-Worker mit D1 und R2. Migrationen
  sind additiv und werden vor dem Code eingespielt, der sie braucht.
- Vor der Live-Installation steht Cloudflare Access. Entschieden: Jedes Gerät
  bekommt einen eigenen Service-Token (Variante A).
- Die Anmeldung der Web-App prüft Turnstile, wenn es eingerichtet ist. Eine
  native App kann das nicht lösen.
- Web-Sitzungen laufen nach 30 Tagen ab; Push hängt heute an der Sitzung.
- Der Server merkt sich nur einen Zähler je Postfach (`jmap_mailbox_revisions`),
  nicht, welche Mail sich wann geändert hat.
- Tests dürfen keine produktiven Daten lesen oder verändern.
- Auf dem Mac mini ist Xcode 27.2 installiert; `xcode-select` zeigt noch auf die
  Command Line Tools und muss vor dem ersten Build umgestellt werden.

## Wege, die zur Wahl standen

1. **Hülle um die bestehende Oberfläche (Capacitor).** Schnell, eine einzige
   Oberfläche, aber Scrollen und Gesten bleiben Web. Empfohlen, nicht gewählt.
2. **Native App in Swift.** Eigene Liste, eigener Leser, eigener Editor, alles
   nativ. Ein Vielfaches an Arbeit, jede Funktion entsteht zweimal. **Gewählt**,
   weil das native Gefühl und die Möglichkeiten von iOS den Aufwand wert sind.
3. **Dünne Hülle, die die Live-Seite lädt.** Verworfen: geht ohne Netz nicht auf.

Für den Aufbau des Hauptbildschirms standen „wie Apple Mail“ und „Leiste unten“
zur Wahl. **Gewählt: wie Apple Mail.**

## Reihenfolge

Jede Stufe läuft für sich auf dem iPhone und wird einzeln geplant und gebaut.

**Block 1: Mail**

1. Fundament: Einrichtung, Anmeldung, Abgleich, Speicher auf dem Gerät,
   Postfachliste, Mailliste, Leser. Alles auch offline. Web-Ansicht für den Rest.
2. Handeln: Archivieren, Löschen, Gelesen, Stern, Zurückstellen, Verschieben,
   Mehrfachauswahl, Wischgesten, Haptik, Vormerken ohne Netz.
3. Schreiben: Neue Mail, Antworten, Weiterleiten, Anhänge, Entwürfe, Ausgang,
   Senden rückgängig, Warnungen vor dem Senden.
4. Mitteilungen: Zustellung über Apple, Aktionen, Zahl am Symbol.
5. Suche und Verteilung: Suche offline und am Server, TestFlight.

**Block 2: Einstellungen** nativ. **Block 3: Kalender und Drive.**
**Block 4: Verwaltung.** Block 3 und 4 mit eigenem Entwurf.

## Aufbau der App

```
Postfächer            ‹ Postfächer            ‹ Posteingang
──────────────        Posteingang             Termin am Donnerstag
Posteingang     3     🔍 Suchen               Anna Krüger  09:12
Markiert              [Allgemein][Rechn.]…    an mich
Zurückgestellt        ● Anna Krüger   09:12   ─────────────────────
Geplant                 Termin am Do…         Passt dir 14 Uhr? …
Gesendet              ● Deutsche Bahn Gest.
Entwürfe        1       Ihre Buchung          📎 Unterlagen.pdf
Archiv                  Markus Hahn    Mo.
Spam · Papierkorb       Re: Angebot Dach
Ordner ▸                                      ▸ 2 frühere Nachrichten
──────────────        ──────────────────      ─────────────────────
Kalender · Drive      ☰ Filter  3 ungel.  ✎   🗑  📁  ↩  ⋯        ✎
Einstellungen
Verwaltung
```

- **Postfächer** ist die oberste Ebene: Konto und Postfach oben, dann die festen
  Ordner mit Zählern, eigene Ordner, darunter Kalender, Drive, Einstellungen und
  (für Administratoren) Verwaltung. Kontowechsel über das Profilbild.
- **Mailliste:** Titel, Suchfeld, die fünf Kategorien als Reihe (nur im
  Posteingang), Zeilen mit Absender, Betreff, Vorschau, Zeit, ungelesen-Punkt,
  Stern und Büroklammer. Unterhaltungsansicht nach der bestehenden Einstellung.
  Unten Filter, Stand des Abgleichs und „Neue Mail“. Ziehen aktualisiert.
- **Offline:** Statt „Gerade aktualisiert“ steht „Offline · Stand 09:14“. Die
  Liste bleibt bedienbar. Eine Mail außerhalb des Zeitraums, die nicht auf dem
  Gerät liegt, zeigt „Wird geladen, sobald du wieder online bist“.
- **Leser:** Kopf mit Absender und Empfängern, Warnbanner bei verdächtigem
  Absender wie im Web, Inhalt, Anhänge mit Vorschau über iOS (Quick Look),
  frühere Nachrichten der Unterhaltung eingeklappt, zitierter Text eingeklappt.
  Externe Bilder nach der bestehenden Einstellung. HTML-Mails zeigt ein
  eingebetteter Web-Rahmen ohne JavaScript; das ist bei jeder Mail-App so.
- **Wischgesten:** nach rechts archivieren, nach links Löschen, Zurückstellen,
  Verschieben. Langes Drücken öffnet das Menü mit allen Aktionen.
- **Schreiben:** Blatt von unten. An/Cc/Bcc mit Vorschlägen aus dem bestehenden
  Adressbuch, Absenderwahl, Betreff, Text mit Fett, Kursiv, Listen und Links,
  Signatur, Anhänge aus Fotos, Dateien, Kamera und Dokumentscan. Der zitierte
  Text einer Antwort bleibt unverändert als HTML erhalten.
- **Haptik:** beim Überschreiten der Wischschwelle, beim Aktualisieren, beim
  Senden, bei Fehlern, beim Öffnen von Menüs, beim Umschalten. In den
  App-Einstellungen abschaltbar; die iOS-Systemeinstellung gilt immer.
- **Aussehen:** iOS-Standardelemente, hell und dunkel nach System, Akzentfarbe
  der Web-App (`#0b57d0` hell, `#8ab4f8` dunkel), dynamische Schriftgröße,
  VoiceOver-Beschriftungen. Deutsch und Englisch.
- **Web-Ansicht:** Bereiche ohne nativen Bildschirm öffnen sich in der App mit
  derselben Anmeldung, ohne Adressleiste.

## Zugang und Anmeldung

Ersteinrichtung in drei Schritten: Serveradresse, Access-Schlüssel des Geräts
(Client-ID und Secret, eintippen, einfügen oder als QR-Code scannen), dann
Mailflare-Anmeldung mit E-Mail, Passwort und gegebenenfalls zweitem Faktor.

- Jede Anfrage trägt `CF-Access-Client-Id` und `CF-Access-Client-Secret`. In
  Cloudflare braucht die Access-Anwendung dafür eine Service-Auth-Regel. Die
  Schritte beschreibt `docs/ios-app.md`.
- Die Web-Ansicht bekommt das von Access ausgestellte Cookie und die
  Mailflare-Sitzung aus der App eingesetzt. **Zu prüfen in Stufe 1**, bevor
  darauf gebaut wird; scheitert es, lädt die Web-Ansicht über einen kleinen
  Vermittler in der App.
- **Geräte-Sitzung:** Neue Route `POST /api/app/login` (und
  `/api/app/login/mfa`) legt eine Sitzung an, die als Geräte-Sitzung markiert
  ist, den Gerätenamen trägt und sich bei Benutzung verlängert. Sie verzichtet
  auf Turnstile, behält die Anmeldebremse und liegt hinter Access. Die App
  schickt die Sitzung wie der Browser als `ep_session`; alle bestehenden
  `/api/*`-Routen funktionieren damit unverändert.
- Geräte-Sitzungen erscheinen unter Sicherheit und lassen sich dort beenden.
  Passwortwechsel beendet sie wie jede andere Sitzung. Antwortet der Server mit
  401, löscht die App ihre lokalen Daten dieses Kontos und zeigt die Anmeldung.
- Mehrere Konten: Jedes Konto hat seine eigene Geräte-Sitzung und seine eigene
  Datenbank auf dem Gerät. Der Wechsel schaltet nur um, ohne neue Anmeldung;
  Mitteilungen kommen für alle angemeldeten Konten.
- Sitzung und Access-Schlüssel liegen im Schlüsselbund, lesbar nach dem ersten
  Entsperren, damit der Abgleich im Hintergrund funktioniert. Die Datenbank der
  App ist mit demselben Schutz verschlüsselt. Optional: App-Sperre mit Face ID.

## Abgleich

**Am Server** kommt ein Änderungsprotokoll dazu: Tabelle `mail_changes`
(laufende Nummer, Postfach, Mail, Art: geändert oder entfernt, Zeit), gefüllt
von Triggern bei Einfügen, Löschen und Änderungen an den Spalten, die Liste und
Leser zeigen. Einträge älter als 45 Tage räumt der bestehende Cron ab.

- `GET /api/app/sync?cursor=…` liefert für alle lesbaren Postfächer die seither
  geänderten Mails als Listenzeilen, die entfernten IDs, Ordner, Zähler und den
  neuen Cursor. Seitenweise. Postfachrechte werden bei jedem Aufruf neu geprüft;
  ein entzogenes Postfach kommt als „entfernt“ zurück.
- Ohne Cursor oder mit einem zu alten Cursor: Erstabgleich. Die App holt
  seitenweise die Mails der letzten 30 Tage, neueste zuerst, und ist nach der
  ersten Seite benutzbar.
- Inhalte holt die App über die bestehende Route `/api/messages/[id]`, im
  Hintergrund für alle Mails im Zeitraum. Anhänge bis 5 MB lädt sie im WLAN
  automatisch, größere beim Antippen. Beides ist einstellbar.
- Auslöser: Start, Rückkehr in den Vordergrund, Ziehen, die bestehende
  Echtzeit-Verbindung (`/api/realtime`, Ereignis `revision`), eine stille
  Mitteilung und die Hintergrundaktualisierung von iOS.
- Mails, die aus dem Zeitraum fallen, bleiben als Zeile ohne Inhalt, bis der
  Speicher gebraucht wird. Ältere Mails lädt die Liste beim Weiterscrollen über
  die bestehende Route `/api/messages` nach.

Das Protokoll kostet je geänderter Mail einen zusätzlichen Schreibvorgang.
Massenaktionen über tausende Mails müssen gegen die Befunde in
`docs/mail-database-contention-2026-11-02.md` gemessen werden; wenn nötig,
schreibt eine Massenaktion einen einzigen Eintrag „Postfach neu abgleichen“.

**Auf dem Gerät** liegt eine SQLite-Datenbank (GRDB) mit Postfächern, Ordnern,
Mailzeilen, Inhalten, Anhängen, Kontakten, Einstellungen, dem Cursor und der
Warteschlange. Ein Volltextindex (FTS5) über Betreff, Absender und Text trägt
die Offline-Suche. Die Oberfläche liest nur aus dieser Datenbank.

## Vormerken ohne Netz

Jede Aktion wird sofort lokal angewendet und als Eintrag in die Warteschlange
geschrieben. Die Warteschlange wird in Reihenfolge abgearbeitet, sobald Netz da
ist, auch im Hintergrund.

- Statusänderungen nutzen die bestehenden Routen (`read`, `star`, `status`,
  `snooze`, `bulk`). Sie sind wiederholbar, ohne Schaden anzurichten.
- Nach dem Abarbeiten gilt der Stand des Servers. Existiert die Mail nicht mehr,
  entfällt der Eintrag.
- Scheitert ein Eintrag endgültig (Recht entzogen, 4xx), macht die App die
  lokale Änderung rückgängig und sagt es dem Nutzer.
- **Senden:** Die Mail liegt im „Ausgang“. Jeder Versand trägt einen vom Gerät
  erzeugten Schlüssel; `/api/send` nimmt ihn als `clientRequestId` an und
  beantwortet eine Wiederholung mit dem ersten Ergebnis, statt erneut zu senden.
  Das ist neu am Server. Ein gescheiterter Versand bleibt im Ausgang mit Grund
  und „Erneut senden“, und die App meldet es mit einer lokalen Mitteilung.
- Warnungen vor dem Senden (Doppelgänger-Adresse, viele Außenstehende, fehlender
  Anhang) rechnet der Server: neue Route `POST /api/app/send-check` über dem
  bestehenden `getSendWarnings`, damit die Regeln nur einmal existieren. Offline
  entfällt die Prüfung; die App sagt das im Ausgang.
- Entwürfe entstehen lokal und werden über `/api/drafts` abgeglichen. Bei
  gleichzeitiger Änderung an zwei Geräten gewinnt die spätere, die andere
  bleibt als zweiter Entwurf erhalten.

## Mitteilungen

- Neue Tabelle `app_devices` (Nutzer, Geräte-Sitzung, APNs-Token, Umgebung,
  Name, zuletzt gesehen), Routen `POST/DELETE /api/app/devices`.
- Der Server signiert mit einem APNs-Schlüssel aus dem Entwicklerkonto
  (`APNS_KEY` als Secret, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`) und
  schickt an Apple aus demselben Pfad, der heute Web-Push verschickt
  (`deliverPushNotifications`), mit denselben Prüfungen: gültige Sitzung,
  aktiver Nutzer, aktuelles Postfachrecht, nicht stumm, nicht zurückgestellt.
  Web-Push bleibt daneben bestehen.
- **Zu prüfen zu Beginn von Stufe 4:** Apple verlangt HTTP/2. Ob der Worker das
  zu `api.push.apple.com` zuverlässig spricht, wird zuerst mit einer
  Testmitteilung belegt. Gelingt es nicht, braucht der Versand einen kleinen
  Vermittler; das wäre eine neue Entscheidung.
- Inhalt: Absender als Titel, Betreff, Vorschau, gruppiert nach Unterhaltung,
  Zahl am Symbol. Aktionen: Archivieren, Als gelesen, Löschen, Antworten mit
  Textfeld. Die Aktionen laufen im Hintergrund über die Warteschlange.
- Die Mitteilung weckt die App, damit die Mail schon auf dem Gerät liegt, wenn
  man sie antippt. Ein vom Server abgelehnter Token wird gelöscht.
- Die Zahl am Symbol wird bei jedem Abgleich und jeder Mitteilung korrigiert.
  Liest man an einem anderen Gerät, schickt der Server eine stille Mitteilung,
  höchstens eine je Minute und Nutzer.

## Einstellungen (Block 2)

Gleiche Gliederung wie im Web, über die bestehenden Routen: Konto (Profil,
Bild, Zeitzone, Sprache), Sicherheit (Passwort, zweiter Faktor, Geräte),
Posteingang (Anzeige, Unterhaltungen, Signatur, Abwesenheit, Weiterleitung,
Sortierung, Spam, externe Inhalte, Senden rückgängig, Papierkorb), Regeln,
Verbindungen (API-Schlüssel, App-Passwörter), Daten (Import, Export). Dazu nur
in der App: Mitteilungen, Offline-Zeitraum und Anhänge, Haptik, App-Sperre,
Zugang (Server, Access-Schlüssel, Abmelden). Bis Block 2 gebaut ist, öffnen die
Web-Einstellungen als Web-Ansicht; die App-eigenen Punkte gibt es ab Stufe 1.

## Projekt und Prüfung

- `ios/` in diesem Repository: App-Ziel `Mailflare` (SwiftUI, Swift 6, ab
  iOS 26), Swift-Paket `MailflareKit` für Zugang, Abgleich, Speicher und
  Warteschlange ohne Oberfläche, später eine Erweiterung für Mitteilungen.
  Einzige fremde Abhängigkeit: GRDB.
- `MailflareKit` wird mit `swift test` gegen einen nachgestellten Server
  geprüft: Erstabgleich, Folgeabgleich, entzogenes Postfach, abgelaufener
  Cursor, Warteschlange mit Abbruch und Wiederholung, doppelter Versand.
- Die neuen Routen und Trigger bekommen Tests in der bestehenden Node-Suite mit
  den echten Migrationen.
- Die Oberfläche wird im Simulator geprüft, mit erfundenen Daten. Haptik,
  Mitteilungen von Apple und der Hintergrundabgleich lassen sich nur auf einem
  echten iPhone prüfen; das wird je Stufe ausdrücklich so berichtet.
- Verteilung über Xcode Cloud und TestFlight wie bei Folio. Dafür braucht es
  Bundle-ID, Team und App-Eintrag aus dem Entwicklerkonto.
- `docs/ios-app.md` beschreibt Einrichtung, Access-Regel, APNs-Schlüssel und Bau.

## Dem Bauenden überlassen

- Schnitt der Swift-Typen und Bildschirme innerhalb der beschriebenen Grenzen.
- Aufbau der Zeilen von `/api/app/sync`, solange sie die Liste ohne zweite
  Anfrage zeichnen können.
- Wie der Texteditor Formatierung in HTML übersetzt.
- Namen der Migrationen (ab `0085`) und der Trigger.
- Reihenfolge innerhalb einer Stufe.

## Festlegungen, die nicht vom Nutzer stammen

Diese Punkte sind Vorschläge des Entwurfs und können geändert werden:

1. Anmeldung der App ohne Turnstile, weil Access davorsteht.
2. Geräte-Sitzungen verlängern sich bei Benutzung, statt nach 30 Tagen zu enden.
3. Anhänge bis 5 MB automatisch nur im WLAN.
4. Mindestversion iOS 26.
5. Texteditor mit Grundformatierung statt des vollen Web-Editors.
6. Stille Mitteilung zum Abgleich der Zahl am Symbol.
7. App-Sperre mit Face ID als Option.
8. Änderungsprotokoll am Server statt wiederholtem Vollabgleich.
9. Sendewarnungen rechnet der Server.
10. iPhone zuerst; Deutsch und Englisch; Code unter `ios/`; TestFlight.
