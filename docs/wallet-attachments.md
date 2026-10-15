# Apple-Wallet-Anhänge

Ein `.pkpass` ist ein signierter Apple-Wallet-Pass und kein PDF. Mailflare erkennt ihn anhand von `application/vnd.apple.pkpass` oder seiner Dateiendung, auch wenn ein importierter Anhang nur als ZIP beziehungsweise Binärdatei gekennzeichnet wurde.

Die Anhangskarte zeigt „Apple-Wallet-Pass“. Ihr nativer Link öffnet `/api/messages/:messageId/attachments/:attachmentId?open=1` mit direkter Nutzeraktivierung in einem neuen Browserfenster. Dadurch wird weder ein PDF-Renderer noch ein iframe verwendet. Wird der gemeinsame Vorschau-Dialog über einen anderen Aufrufer geöffnet, bietet er ebenfalls „In Apple Wallet öffnen“ anstelle der Warnung für unbekannte Dateitypen. Herunterladen bleibt verfügbar.

Der bestehende Anhangs-Endpunkt prüft Sitzung und aktuelle Postfachberechtigung auch für `open=1`. Er streamt die unveränderten Originalbytes mit `application/vnd.apple.pkpass` und `Content-Disposition: inline`; `download=1` hat Vorrang und verwendet weiterhin `attachment`. Cache-Schutz, CSP und `nosniff` bleiben erhalten. Es gibt keine öffentlichen Dateilinks und keine Sitzungstoken in der URL. Auf dem iPhone wird der bestehende HTTP-only-Sitzungscookie verwendet.

Nur Wallet-Pässe erhalten dieses native Öffnungsverhalten. HTML/SVG oder andere unbekannte Dateien werden durch `open=1` nicht als sichere Browser-Vorschau freigeschaltet. PDF-Vorschau, Seitenanpassung und Zoom behalten ihren bisherigen Ablauf.

`tests/wallet-attachments.test.mjs` prüft Typ-/Dateinamenerkennung, die tatsächliche Anhangsroute mit Cookie-Anmeldung, Header und unveränderte Bytes, abgelaufene/fremde Sitzungen, deaktivierte Postfächer sowie Karte und Dialog. Der Produktions-Browsertest `tests/browser/attachment-preview.mjs` prüft zusätzlich den nutzeraktivierten Öffnen-Link in einer eigenen Browseransicht und die bestehenden PDF-Fälle bei vier Bildschirmgrößen. Chromium kann keine echte Wallet-Annahme prüfen: Die native Anzeige, die Bestätigung zum Hinzufügen und die Signaturprüfung müssen auf einem unterstützten Apple-Gerät erfolgen. Eine ungültige oder abgelaufene Pass-Signatur wird durch diese Änderung nicht repariert.
