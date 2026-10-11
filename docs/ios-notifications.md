# iPhone: Push-Mitteilungen und ungelesene E-Mails

Mailflare unterstützt Web Push für die Safari-App auf dem Home-Bildschirm ab
iOS/iPadOS 16.4. Das Hinzufügen zum Home-Bildschirm allein erteilt noch keine
Mitteilungsfreigabe.

1. Mailflare über das App-Symbol auf dem Home-Bildschirm öffnen und anmelden.
2. **Einstellungen → Posteingang → Push-Benachrichtigungen** aktivieren und die
   iOS-Freigabe erlauben. Die Freigabe gilt jeweils für dieses Gerät.
3. **Testbenachrichtigung senden** antippen. Der Test adressiert ausschließlich
   das aktuelle Gerät und den angemeldeten Account.
4. Unter **iPhone-Einstellungen → Mitteilungen → Mailflare** Mitteilungen,
   Banner und **Kennzeichen** erlauben. Fokus und Mitteilungszusammenfassung
   können Banner verzögern oder unterdrücken.

Das Kennzeichen am App-Symbol zählt ungelesene empfangene E-Mails über alle
für den aktuellen Account lesbaren Postfächer einschließlich eigener Ordner.
Spam, Papierkorb, Archiv und aktuell zurückgestellte E-Mails zählen nicht mit.
Beim Öffnen und bei Lese-/Ordneränderungen wird die Anzahl vom Server neu
abgerufen. Bei neuen E-Mails aktualisiert der Service Worker die Anzahl aus dem
Push-Inhalt, auch wenn die App geschlossen ist. Änderungen auf einem anderen
Gerät werden beim nächsten Öffnen bzw. Eingang aktualisiert; es gibt keine
stillen Hintergrund-Pushes ausschließlich zum Synchronisieren der Anzahl.

Nach einem Update die Home-Bildschirm-App erneut öffnen, damit Safari den
Service Worker aktualisieren kann. Ein bestehendes Push-Abonnement wird beim
Anmelden bzw. erneuten Öffnen an die aktuelle Sitzung gebunden. Bei Problemen
Push einmal aus- und wieder einschalten und den Test erneut ausführen. Die App
fragt ausschließlich nach einem bewussten Antippen um die Mitteilungsfreigabe.

## Server-Einrichtung

Die vorhandene Web-Push-Konfiguration benötigt dauerhaft dasselbe
VAPID-Schlüsselpaar. Ein GitHub-Push richtet diese Werte nicht automatisch ein.
Wenn die App „auf dem Server noch nicht eingerichtet“ anzeigt, fehlen gültige
Runtime-Werte. Ein Administrator generiert mit `npm run push:keys` einmal das
Schlüsselpaar und hinterlegt im Cloudflare-Worker:

- `VAPID_PRIVATE_KEY` als **Secret**;
- `VAPID_PUBLIC_KEY` als Variable;
- `VAPID_SUBJECT` als Variable, zum Beispiel `https://mail.stepo-data.de`.

Den privaten Schlüssel nicht ins Repository oder in den Chat kopieren. Die
Werte müssen bei automatischen Builds erhalten bleiben. Ein ausgetauschtes
Schlüsselpaar erfordert neue Browser-Abonnements; die App ersetzt ein altes
Abonnement beim erneuten Aktivieren.

Die Mitteilungen werden verschlüsselt an den Push-Dienst des Geräts übergeben.
Sitzung, aktiver Benutzer und aktuelle Postfachrechte werden vor dem Versand
geprüft. Abgelaufene, abgemeldete oder deaktivierte Sitzungen erhalten keine
E-Mail-Mitteilungen. Mitteilungen zeigen derzeit Betreff und Absender; wie viel
davon auf dem Sperrbildschirm sichtbar ist, steuert iOS über „Vorschauen zeigen“.

## Prüfung

Automatisierte Tests prüfen verschlüsselte Push-Payloads und Badge-Anzahlen,
Postfachrechte und deren Entzug, abgelaufene Sitzungen, Erstaktivierung und
Schlüsselwechsel sowie Service-Worker-Verhalten und veraltete Badge-Antworten.
Eine tatsächliche Zustellung über Apple und die Anzeige auf einem echten iPhone
erfordern den Test auf dem eingerichteten Gerät mit den produktiven VAPID-Werten.
