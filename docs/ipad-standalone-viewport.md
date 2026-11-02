# Stabile Kopfzeile in der iPad-Homescreen-App

Stand: 2. November 2026.

## Befund und Änderung

Auf einem iPad Mini wurde nach dem Scrollen eine nach oben versetzte, unter der
Statusleiste verschwommene Kopfzeile gemeldet. Der Screenshot und die
Quellcodeprüfung sprechen für ein Verschieben des Dokument-/Browser-Viewports;
die Kopfzeile selbst verwendet keinen Blur-Filter. Die native iPadOS-Ursache ist
ohne Gerätetest nicht abschließend bestätigt.

Die bisherige CSS-Regel sperrte nur den Body und galt nur unter 1024 CSS-Pixeln.
Das Dokument konnte weiterhin am nativen Scrollverhalten beteiligt sein. Im
iPad-Mini-Querformat mit 1133 CSS-Pixeln entfiel zudem der Sicherheitsabstand zur
Statusleiste vollständig.

`src/app/globals.css` begrenzt nun HTML und Body, solange die Mail-Oberfläche
eingehängt ist, und verhindert Dokument-Overscroll. Der Body und die App-Fläche
sind am Viewport verankert. Die vorhandenen Listen-, Lese- und Menübereiche
scrollen weiterhin selbst. Alle vier Safe-Area-Abstände gelten unabhängig von
der Bildschirmbreite und damit auch nach Drehung des iPads. Andere Seiten ohne
Mail-Oberfläche behalten ihr normales Dokument-Scrollverhalten.

Es gibt keine zusätzlichen Touch-Listener, kein erzwungenes Zurückscrollen per
JavaScript und keine deaktivierte Vergrößerung. Die anschließende Untersuchung
der nativen Browserleiste und Statusleisten-Unschärfe ist unter
[iOS-Installation und Navigation](ios-pwa-installation.md) dokumentiert.

## Reproduzierbare Prüfung

```sh
npm run check:quality
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/standalone-viewport.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:smoke
```

Die fokussierte Browserprüfung verwendet den gebauten lokalen Worker mit
synthetischen Maildaten. Chromium emuliert Bildschirmgrößen und Safe-Area-Werte;
dies ist kein echter iPadOS- oder Homescreen-Test. Die Suite läuft auch in der
vorhandenen sequenziellen CI-Browserprüfung. Sie benötigt keine zusätzlichen
Cloudflare-Dienste und liest oder ändert keine produktiven Nachrichten.

Gemessen unter Linux mit Chromium 154, synthetisch gesetztem oberen/unteren
Sicherheitsabstand von 24/20 Pixeln auf dem iPad:

| Bedingung | Vorher | Nachher |
| --- | --- | --- |
| iPad Mini 1133 × 744, hell/dunkel | Kopfzeile bei y = 0 trotz 24 Pixeln Safe Area | y = 24 vor und nach Scrollen |
| Drehung 744 × 1133 → 1133 × 744, hell/dunkel | Oberer Abstand fällt von 24 auf 0 | Abstand bleibt 24 |
| iPad Mini 744 × 1133, hell/dunkel | Oberer Abstand bereits 24 | Weiterhin 24; Dokument-Scrollposition 0 |
| iPhone 390 × 844, dunkel | Oberer Abstand 47 | Weiterhin 47; Dokument-Scrollposition 0 |
| Desktop 1440 × 900, hell | Oberer Abstand 0 | Weiterhin 0; Dokument-Scrollposition 0 |

Alle sechs Szenarien einschließlich der beiden zusätzlichen Drehungen bestehen
mit echtem Touch-/Wheel-Input im Testbrowser, Scrollversuchen an den Listenrändern,
Suchfokus, Menü, Schnelleinstellungen und Öffnen/Schließen des Entwurfsfensters.
Die Liste bewegt sich dabei um mindestens 200 Pixel, die Kopfzeile nicht. Diese
Ergebnisse belegen die Geometrie und Scroll-Trennung; eine Behebung des nativen
iPadOS-Unschärfeeffekts ist erst mit der folgenden Geräteabnahme nachgewiesen.

Zusätzliche Freigabe: Typprüfung und Lint ohne Fehler, 793/793 gewöhnliche Tests,
Produktionsbuild einschließlich Farb-/HTTP-Cache-Prüfung sowie 10/10 Browser-Suites
bestanden. Die Browser-Suites decken auch Anhänge, Schreiben mit simulierter
Tastatur, Labels, Sternfehler, Entwurfswiederherstellung und Cookie-Anmeldung ab.

## Abnahme auf dem Gerät und Rollback

Nach dem Git-/Cloudflare-Deployment die bestehende Homescreen-App vollständig
schließen und erneut öffnen. Im Hoch- und Querformat eine längere Liste nach
oben und unten scrollen und an beiden Enden weiterziehen. Profilbild und Suche
müssen unterhalb der Statusleiste an derselben Position bleiben. Zusätzlich
Suche, Seitenmenü, Einstellungen und Entwurf mit geöffneter Bildschirmtastatur
prüfen. Dieselben Schritte auf dem iPhone gegenprüfen.

Für diese Änderung ist keine Migration nötig. Bei einer Regression den
Viewport-Fix per Git-Revert über den bestehenden Cloudflare-Build zurücknehmen;
keine Datenbank oder Maildaten zurücksetzen.
