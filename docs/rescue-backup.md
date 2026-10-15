# Ein verschlüsselter Rettungsstand

Mailflare verwendet zwei Schutzmechanismen:

- **D1 Time Travel** läuft bei Cloudflare automatisch und ohne zusätzliche Backup-Gebühren. Es bietet 30 Tage Datenbankverlauf im Paid-, 7 Tage im Free-Tarif. Es stellt keine gelöschten R2-Dateien wieder her.
- **Ein zusätzlicher Rettungsstand** enthält die Datenbank und die Dateien des Live-Speichers: Original-E-Mails, Anhänge, Profilbilder und Drive-Dateien. Das Ziel ist der separate, private R2-Bucket `mailflare-rescue`, angebunden als `RESCUE_BUCKET`.

Beide Buckets gehören zunächst zum selben Cloudflare-Konto. Die separate Kopie schützt vor Löschvorgängen im Live-Bucket; ein Verlust des gesamten Kontos erfordert eine außerhalb dieses Kontos aufbewahrte Kopie.

Worker-Konfiguration und Cloudflare-Secrets sind kein Teil dieser Datenkopie. Beim Wiederaufbau eines neuen Workers müssen dessen bisherige Konfiguration und benötigte Secrets gesichert übernommen werden. Der private Wiederherstellungsschlüssel gehört weiterhin ausschließlich auf dein eigenes Gerät.

## Einmal einrichten

1. **Administration → Backups / Rettungsstand** öffnen.
2. Ein Wiederherstellungspasswort mit mindestens 12 Zeichen wählen und wiederholen.
3. **Schlüssel in diesem Browser erstellen** wählen.
4. **Private Schlüsseldatei herunterladen** und Datei sowie Passwort sicher außerhalb Mailflares aufbewahren. Ohne beides ist dieser Rettungsstand nicht entschlüsselbar. Mailflare kann den privaten Schlüssel nicht wiederherstellen.
5. Das sichere Ablegen bestätigen und **Verschlüsselten Rettungsstand aktivieren** wählen.

Die Aktivierung startet die erste Sicherung und aktiviert die wöchentliche Erneuerung, standardmäßig sonntags um 02:00 UTC. In Deutschland entspricht das je nach Sommer-/Winterzeit 04:00/03:00 Uhr. Häufigkeit und Wochentag können anschließend angepasst werden.

Die bisherigen täglichen Datenbank-Exporte werden durch Migration `0079` abgeschaltet. Die vorhandenen Sicherungen bleiben erhalten, bis der erste verschlüsselte Rettungsstand erfolgreich geprüft wurde. Ohne eingerichteten öffentlichen Schlüssel beginnt keine neue Sicherung.

## Verschlüsselung und Zugriff

Die private RSA-3072-Schlüsseldatei entsteht ausschließlich im Browser. Sie wird dort mit AES-256-GCM und einem durch PBKDF2-SHA256 (600.000 Iterationen, zufälliges Salt) abgeleiteten Passwortschlüssel geschützt. An den Server geht nur der öffentliche RSA-Schlüssel. Private Schlüsselparameter werden vom Einrichtungsendpunkt abgelehnt; vorhandene Schlüssel lassen sich dort nicht versehentlich überschreiben.

Der Worker verschlüsselt jeden Datenblock mit einem eigenen zufälligen AES-256-GCM-Schlüssel. Dieser Schlüssel wird mit RSA-OAEP/SHA-256 für den öffentlichen Wiederherstellungsschlüssel verpackt. Der Worker speichert keinen privaten Entschlüsselungsschlüssel. Auch Datenbankteile, Dateinamen, Metadaten und das ausführliche Manifest werden verschlüsselt. Der kleine Zeiger `rescue/current.json` enthält nur Format, Algorithmus, Fingerabdruck und die Prüfsumme des verschlüsselten Manifests.

Der Bucket besitzt keinen öffentlichen `r2.dev`-Zugang und keine öffentliche Domain. Die Backup-API bleibt dem primären Administrator vorbehalten; Downloads werden nicht im Browser-Cache gespeichert. Zusätzliche Cloudflare-Speicherverschlüsselung bleibt bestehen. Die hier beschriebene zusätzliche Verschlüsselung gilt für den Rettungsstand; die laufende Mail-Anwendung verarbeitet ihre E-Mails weiterhin im normalen Live-Speicher.

## Austausch und Speicherbedarf

Die Sicherung läuft über die bestehende Queue weiter, wenn die App geschlossen wird. Datenbankabfragen und Dateiblöcke sind begrenzt; große Dateien werden stückweise kopiert. Unveränderte Dateien werden anhand von Quellschlüssel, ETag und Schlüsselfingerabdruck wiederverwendet. Eine Gelesen-Markierung führt damit nicht zur erneuten Kopie sämtlicher Originaldateien. Die Datenbankteile werden bei jeder wöchentlichen Erneuerung vollständig, komprimiert und verschlüsselt geschrieben.

Neue Blöcke werden durch erneutes Lesen und SHA-256-Prüfung kontrolliert. Referenzierte Originaldateien müssen vorhanden sein; Datenbankbezüge zwischen den exportierten Datensätzen werden geprüft. Erst danach ersetzt der Worker atomar `rescue/current.json`. Anschließend löscht er ältere Datenbank-Exporte und nicht mehr benötigte Datenblöcke. Gemeinsam verwendete Dateien bleiben erhalten.

Es gibt einen gültigen Rettungsstand, während der Erneuerung vorübergehend zusätzlich einen neuen Stand. Ein fehlgeschlagener neuer Lauf entfernt den bisherigen gültigen Stand nicht. Der letzte gültige Stand verfällt nicht nach einer festen Anzahl von Tagen. Nach einem Abbruch werden committed Prüfpunkte über den Fünf-Minuten-Cron wieder aufgenommen. Die Oberfläche zeigt Phase, geprüfte Dateien und Größe an.

Die Kopie entsteht während des laufenden Betriebs; sie ist kein transaktionaler Zeitpunktsnapshot wie D1 Time Travel. Erkannte fehlende Dateiverweise oder Eltern-Datensätze verhindern die Freigabe. Ein solcher Lauf muss erneut gestartet werden, wenn die Ursache behoben ist.

## Lokal wiederherstellen und prüfen

Benötigt werden Python 3.10+, `cryptography`, die AWS CLI, die private Schlüsseldatei samt Passwort und ein R2-Profil mit **Leserecht auf `mailflare-rescue`**. Das bisherige Profil für den Live-Bucket hat dieses Recht möglicherweise noch nicht. Secrets ausschließlich in den lokalen CLI-Einstellungen beziehungsweise über geschützte Umgebungsvariablen hinterlegen.

```bash
python3 -m venv .recovery-venv
.recovery-venv/bin/pip install cryptography

.recovery-venv/bin/python scripts/recover-rescue.py \
  --account-id DEINE_CLOUDFLARE_ACCOUNT_ID \
  --profile mailflare-r2 \
  --key-file /sicherer/pfad/mailflare-wiederherstellungsschluessel.json \
  --output /sicherer/pfad/mailflare-wiederhergestellt
```

Das Passwort wird verdeckt lokal abgefragt. Der private Schlüssel und sein Passwort werden nicht übertragen. Die Entschlüsselung arbeitet mit begrenzten Blöcken, einschließlich großer Originaldateien. Als Quelle kann mit `--source-directory` auch ein bereits heruntergeladener verschlüsselter Bucket verwendet werden. Eine heruntergeladene Wiederherstellungsbeschreibung kann über `--descriptor` übergeben werden.

Die Ausgabe enthält:

- `mailflare.sqlite`: geprüfte Datenbank;
- `objects/` und `objects.ndjson`: Originaldateien mit ihrer Zuordnung und Prüfsummen;
- `manifest.json` und `recovery.json`: Bestands- und Wiederherstellungsangaben;
- `VERIFIED`: wird erst nach erfolgreicher Inhalts-, Fremdschlüssel- und Datenbankprüfung angelegt.

Die Ausgabe enthält entschlüsselte Daten und gehört auf einen geschützten Rechner beziehungsweise Datenträger. Ein bestehendes Ausgabeverzeichnis mit Inhalt wird nicht überschrieben. Die laufende Cloudflare-Installation bleibt bei diesem Schritt unverändert.

## In neue Cloudflare-Ressourcen importieren

Für einen echten Notfall zuerst eine **neue leere D1-Datenbank** und einen **neuen leeren R2-Bucket** anlegen. Die laufenden Ressourcen bis zur abschließenden Prüfung behalten. Der Import verweigert bereits belegte Ziele.

Ein Cloudflare-API-Token mit D1-Schreibberechtigung wird lokal über `CLOUDFLARE_API_TOKEN` bereitgestellt. Das AWS-Profil benötigt Schreibrecht auf den neuen Ziel-Bucket. Schlüssel und Token nicht im Chat oder im Repository hinterlegen.

```bash
.recovery-venv/bin/python scripts/restore-rescue-to-cloudflare.py \
  --recovered /sicherer/pfad/mailflare-wiederhergestellt \
  --account-id DEINE_CLOUDFLARE_ACCOUNT_ID \
  --target-database-id UUID_DER_NEUEN_LEEREN_DATENBANK \
  --target-bucket NAME_DES_NEUEN_LEEREN_BUCKETS \
  --profile mailflare-r2-restore \
  --apply-to-empty-targets
```

Das Werkzeug überträgt zuerst die Originaldateien und importiert die Datenbank in begrenzten parametrisierten Abfragen. Dadurch werden auch große Nachrichtentexte nicht als riesige SQL-Anweisungen gesendet. Zeilenzahlen und Fremdschlüssel werden abschließend geprüft. Die Anwendung wird dabei noch nicht auf die neuen Ressourcen umgestellt.

Sitzungen werden nicht wiederbelebt. Aktive Import-/Stapelaufträge und automatische Versand-/Paperless-/KI-Aufträge werden angehalten beziehungsweise zur Prüfung markiert; automatische Backups bleiben nach dem Restore zunächst deaktiviert. Erst nach Kontrolle die `DB`- und `BUCKET`-Bindings auf die neuen Ressourcen umstellen und benötigte Automatisierungen wieder aktivieren. Die private Schlüsseldatei wird dazu nicht auf den Worker geladen.

## Technische Prüfung

`tests/rescue-backup.test.mjs` prüft unter anderem Verschlüsselung, Manipulationserkennung, fehlende Referenzen, fortsetzbare große Dateien, Wiederverwendung, sicheren Austausch, Administratorrechte und die Wiederherstellung über beide Python-Werkzeuge. Ein Test führt die Verschlüsselung samt komprimierter R2-Kopie in der tatsächlichen Workers-Laufzeit aus. `tests/browser/recovery-key.mjs` prüft die Schlüsselerstellung und den privaten Download im Browser.
