# Mobile Einstellungen: Recherche und Umsetzung

Stand: 15. Oktober 2026. Die folgenden Primärquellen wurden aus den aktuellen offiziellen GitHub-Repositories abgerufen. Das ist eine gezielte Untersuchung der Einstellungsnavigation, keine Behauptung, sämtliche aktuellen mobilen UX-Lösungen oder Apple-Richtlinien geprüft zu haben.

## Quellen und Konsequenzen

- [Material: Navigation bar, einschließlich M3 Expressive](https://github.com/material-components/material-components-android/blob/master/docs/components/BottomNavigation.md): drei bis fünf beschriftete Ziele unten, direkter Wechsel mit einem Tippen. Die aktuelle Expressive-Variante verkürzt die Standardhöhe von 80 auf 64 dp. Mailflare verwendet eine kompakte 64-CSS-Pixel-Leiste mit vier Einträgen; dp und CSS-Pixel sind keine geräteübergreifend identischen physikalischen Einheiten.
- [Material: Bottom sheets](https://github.com/material-components/material-components-android/blob/master/docs/components/BottomSheet.md): sekundäre Auswahl am unteren Bildschirmrand, bei modaler Darstellung mit abgedunkeltem und gesperrtem Hintergrund.
- [W3C: Target Size (Minimum), WCAG 2.2](https://github.com/w3c/wcag/blob/main/understanding/22/target-size-minimum.html): mindestens 24 × 24 CSS-Pixel oder definierte Ausnahmen/Abstände. [Target Size (Enhanced)](https://github.com/w3c/wcag/blob/main/understanding/21/target-size-enhanced.html) beschreibt 44 × 44. Die neue Bereichsauswahl verwendet mindestens 48 Pixel hohe Ziele, die untere Navigation mindestens 64; alle Ziele sind auch breit genug.
- [W3C: Focus Not Obscured](https://github.com/w3c/wcag/blob/main/understanding/22/focus-not-obscured-minimum.html): feste Bedienelemente dürfen fokussierte Inhalte nicht vollständig verdecken. Unten wird Platz für Navigation und Geräte-Sicherheitsabstand reserviert.
- [WAI-ARIA: Modal Dialog Pattern](https://github.com/w3c/aria-practices/blob/main/content/patterns/dialog-modal/dialog-modal-pattern.html): Fokus im geöffneten Dialog halten, Hintergrund sperren, Escape und sichtbares Schließen anbieten und Fokus zum Auslöser zurückgeben. Dafür wird die bereits vorhandene Radix-Dialogbibliothek verwendet.

## Gestaltung in Mailflare

Auf Handys ersetzt eine feste untere Leiste die Bereichsauswahl am oberen Rand. Postfach führt zurück zu den Nachrichten; Konto und E-Mail öffnen ihre Einstellungen direkt. Der kurze Text E-Mail vermeidet Umbrüche bei größerer Schrift; der zugängliche Name nennt ausdrücklich die Posteingang-Einstellungen. Mehr öffnet alle acht Einstellungsbereiche, nach Aufgabe gruppiert. Es werden nicht acht kleine Tabs nebeneinander oder weitere verschachtelte Untermenüs eingeführt. In der Bereichsauswahl zeigt eine Markierung die aktuelle Seite; Schließen bleibt am unteren Rand erreichbar. Das Menü schließt nach Auswahl oder Wechsel auf Desktopbreite.

Sprache, Design und Leselayout bleiben ohne Aufklappen erreichbar. Erweiterte Einstellungen behalten ihre Formularwerte beim Schließen und Öffnen. Desktopnavigation und URLs bleiben erhalten. Navigation und Animationen respektieren Safe Areas, kleine Fenster und reduzierte Bewegung. Das Menü verwendet eine kurze Transform-Animation und keine zusätzliche Animationsbibliothek oder aufwendige Unschärfeeffekte.

Die Browserprüfung umfasst mehrere Bildschirmbreiten, kurze Fenster, Scrollen, Fokusbindung und -rückgabe, Escape, Navigation, erhaltene Formulareingaben, große Schrift und reduzierte Bewegung. Sie ersetzt keinen Test der echten iOS-Tastatur oder einen vollständigen VoiceOver-/WCAG-Audit.

## Verifikation

Der Produktionsbuild, ESLint für die geänderten Komponenten und alle 31 Browserfälle sind erfolgreich. Geprüft wurden 320, 390 und 1440 Pixel Breite sowie kurze Fenster bis 375 Pixel Höhe und um 25 Prozent vergrößerte Basisschrift. Nach dem Schließen wird auch die Entfernung der Hintergrundabdeckung geprüft.

Die globale Typprüfung hat weiterhin dieselben 15 bereits bestehenden Fehler außerhalb dieser Änderung. Die zusätzlich ausgeführte Übersetzungssuite hat drei erfolgreiche und fünf fehlgeschlagene Tests: vorhandene fehlende Katalogschlüssel und abweichende portugiesische Übersetzungen. Die betreffenden Kataloge und Übersetzungsfunktionen wurden durch diese Änderung nicht verändert. Diese Ergebnisse sind kein vollständig erfolgreicher globaler Testlauf.
