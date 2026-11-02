# iOS-Homescreen-App: Installation, Navigation und Statusleiste

Stand: 2. November 2026. Die App läuft weiterhin über den bestehenden
Cloudflare-Worker und Cloudflare Access.

## Beobachtung und Ursachenabgrenzung

Die Geräteaufnahmen zeigen im Posteingang eine verschwommene obere Kopfzeile.
Nach dem Wechsel zu Rechnung, Werbung oder anderen Kategorien erscheint eine
native Leiste mit Schließen, Zurück, Domain, Teilen und Safari. Diese Leiste wird
von iPadOS gezeichnet. Sie passt zu einer Navigation außerhalb des vom System
gespeicherten App-Bereichs; den tatsächlichen Installationszustand des iPads
können die lokalen Tests nicht auslesen.

Die Kategorien verwenden bereits interne Links und den Client-Router. Der
gebaute Worker lieferte vor der Korrektur ein gültiges Manifest unter
`/manifest.webmanifest`, jedoch mit einem **nicht credentialed Manifest-Link**.
Der echte Manifest-Lader im Testbrowser ließ deshalb selbst bei gleicher Origin
das gesetzte Test-Access-Cookie weg. Eine vorgeschaltete simulierte Access-Prüfung
lieferte dann Anmelde-HTML statt Manifest-JSON.

Das entspricht der untersuchten WebKit-Implementierung: Der Manifest-Lader nutzt
`CredentialsMode::Include` nur für `crossorigin="use-credentials"`, sonst `Omit`.
Das ist eine konkrete Inkompatibilität mit einem durch Cookie-Anmeldung
geschützten Manifest. Eine tatsächliche Access-Weiterleitung während der
Installation auf diesem iPad wurde nicht aufgezeichnet; der Zusammenhang mit
genau dieser Installation bleibt deshalb eine begründete Vermutung.

Ein fehlendes explizites `scope` ist allein **kein** Fehler: Aus dem vorhandenen
`start_url: "/inbox"` ergibt sich bereits der Standardbereich `/`. Auch die
Service-Worker-Registrierung unter `/` war korrekt. Ein Service-Worker-Bereich
ersetzt den Navigationsbereich eines installierten Web-App-Manifests nicht.

## Umsetzung

- Genau ein Manifest-Link im initialen HTML, mit
  `href="/manifest.webmanifest"` und `crossorigin="use-credentials"`. Eine zweite
  korrigierte Verknüpfung nach einem automatisch erzeugten falschen Link würde
  nicht genügen: WebKit verwendet den ersten passenden Link.
- Explizite Route `src/app/manifest.webmanifest/route.ts` statt automatischer
  Dateimetadaten. So entsteht kein zusätzlicher Link durch Vinext. Die URL bleibt
  gleich; die Antwort ist `application/manifest+json` mit `Cache-Control: no-cache`.
- `scope: "/"` dokumentiert alle internen Kategorien, Einstellungen und
  Nachrichtendetails als Teil derselben App. `id: "/inbox"` erhält die zuvor aus
  `start_url` abgeleitete Identität; ein Wechsel zu `id: "/"` wäre hier unnötig.
- Der initiale Apple-Statusleistenwunsch und der Client-/Theme-Bootstrap verwenden
  im dunklen Modus `black` statt `black-translucent`. Damit wird keine
  durchscheinende Statusleiste mehr angefordert. Im hellen Modus bleibt `default`.
  Die tatsächliche Darstellung obliegt iPadOS; der native Unschärfeeffekt braucht
  weiterhin eine Geräteabnahme.
- Statusleisten- und Theme-Farbe stehen ausdrücklich vor dem Theme-Bootstrap im
  initialen Head. Die Browserprüfung entdeckte zuvor zwei Statusleisten-Tags:
  Der Bootstrap erzeugte einen frühen Eintrag, bevor der Renderer seinen Eintrag
  nachlieferte. Der Renderer erzeugt nun keinen zusätzlichen Statusleisten-Tag;
  der Theme-Code aktualisiert den bereits vorhandenen Eintrag.
- Zusätzlich zum von Vinext erzeugten modernen Capability-Meta bleibt Apples
  ausdrückliches `apple-mobile-web-app-capable=yes` im initialen HTML vorhanden.

Interne Router-Links und die vorherige Safe-Area-/Scrollkorrektur bleiben erhalten.
Es werden keine pauschalen Link-Handler eingeführt. Cloudflare Access und die
Zugriffskontrollen für Nachrichten bleiben aktiv. Es entstehen keine zusätzlichen
Cloudflare-Dienste oder Infrastrukturkosten.

## Reproduzierbare Prüfungen

```sh
npm run check:quality
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/standalone-viewport.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:smoke
```

Die erweiterte Browserprüfung lädt das Manifest über `Page.getAppManifest`, nicht
über ein gewöhnliches JavaScript-`fetch()`, dessen Cookie-Verhalten anders sein
kann. Die synthetische Access-Grenze verweigert Manifest-Anfragen ohne Test-Cookie.
Geprüft werden ein einzelner credentialed Link in SSR und DOM, gültige
App-Metadaten, konsistente Statusleistenangaben, alle fünf Kategorien und
Zurück/Vorwärts ohne neues Dokument, der sichtbare Theme-Wechsel sowie die
bisherigen Scroll-/Drehprüfungen.
Die zusätzliche Build-Prüfung kontrolliert die tatsächliche HTTP-Antwort der
neuen Manifest-Route. Es werden keine produktiven Nachrichten gelesen oder
versendet. Eine echte Safari-/iPadOS-Installation wird damit nicht simuliert.

Vorher/Nachher unter Chromium 154 auf Linux: Alle sechs geprüften Konfigurationen
scheiterten zunächst an der fehlenden Cookie-Übermittlung an das geschützte
Manifest. Mit der Korrektur bestehen iPad Mini 744 × 1133 und 1133 × 744 jeweils
hell/dunkel, iPhone 390 × 844 dunkel und Desktop 1440 × 900 hell. Jede Variante
lädt ein gültiges Manifest mit Anmeldung und durchläuft alle fünf Kategorien plus
Zurück/Vorwärts mit **null zusätzlichen Dokumentnavigationen**. Statusleisten-
und Theme-Farb-Metadaten sind im initialen HTML und nach den Wechseln jeweils
genau einmal vorhanden. Der sichtbare Theme-Schalter wurde in beiden iPad-
Querformatvarianten und am Desktop zusätzlich hin- und zurückgeschaltet.

Die übrige Freigabe umfasst 793 bestandene gewöhnliche Tests, Typprüfung und
Lint, den Produktionsbuild mit tatsächlicher Manifest-/Cache-HTTP-Prüfung und
10/10 Browser-Suites auf dem abschließenden Build. Nach der letzten Head-
Bereinigung wurden Typprüfung, betroffene Sprach-/Root-Layout-Tests und
Browser-Suites erneut ausgeführt. Die vorhandene Lesebereich-Prüfung erwartet
ebenfalls die neue undurchsichtige Statusleiste; ihr umfangreicher separater
Gesamtlauf war für diese Änderung nicht erforderlich.

## Bestehende Installation und Geräteabnahme

Nach dem Deployment die Homescreen-App vollständig schließen und neu öffnen.
Allgemein → Rechnung → Werbung → Soziale Netzwerke → Bestellung → Allgemein
prüfen, dann im Hoch-/Querformat scrollen. Erwartet wird ein gleichbleibender
App-Rahmen ohne zusätzliche native Browserleiste und eine klare Kopfzeile.

iPadOS muss eine bestehende Installation nicht sofort mit neuen Metadaten
aktualisieren. Falls die native Leiste bestehen bleibt, zunächst Entwürfe
erfolgreich speichern, dann die Homescreen-Verknüpfung entfernen und die
angemeldete Mailflare-Seite in Safari erneut zum Home-Bildschirm hinzufügen.
Dadurch können lokale Sitzungen, Entwurfswiederherstellung und Push-Berechtigungen
verloren gehen; anschließend anmelden und Push bei Bedarf erneut aktivieren.
Das ist ein bedingter Wiederherstellungsschritt, keine für alle Geräte belegte
Notwendigkeit. Keine Cloudflare-Access-Ausnahme ist für die Korrektur erforderlich.

Rollback erfolgt über den bestehenden Git-/Cloudflare-Build. Es gibt keine
Schemaänderung und keine Datenmigration. Das Manifest bleibt unter derselben URL.

## Quellen

- [WebKit: Auswahl des ersten Manifest-Links und Credentials](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/loader/DocumentLoader.cpp)
- [WebKit: Manifest-Lader mit Include/Omit](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/loader/ApplicationManifestLoader.cpp)
- [WebKit: Standardwerte für Scope und Identität](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/applicationmanifest/ApplicationManifestParser.cpp)
- [MDN-Quelldokumentation: Scope und Browserkontrollen](https://github.com/mdn/content/blob/main/files/en-us/web/progressive_web_apps/manifest/reference/scope/index.md)

Die untersuchte WebKit-Implementierung ist von der aktuellen abstrakten
HTML-Spezifikation zu unterscheiden; eine allgemeine Behauptung, dass jedes
Browser-Manifest ohne dieses Attribut Cookies immer auslässt, wird nicht gemacht.
