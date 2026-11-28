#!/usr/bin/env python3
"""Writes Mailflare/Localizable.xcstrings from the table below.

English is the key, German the translation. Where one English word needs two German ones,
the key is a name and the value a pair (English, German). After changing a text in the app, add or change
its line here and run:  python3 ios/tools/strings.py
`--check <DerivedData>` lists texts the build found in the code that have no line here.
"""
import glob
import json
import os
import sys

GERMAN = {
    # Setup
    "Your Mailflare": "Dein Mailflare",
    "Enter the address of your Mailflare installation, the one you open in the browser.": "Gib die Adresse deiner Mailflare-Installation ein, so wie du sie im Browser öffnest.",
    "Continue": "Weiter",
    "Server address": "Serveradresse",
    "mail.example.com": "mail.example.com",
    "Access key": "Zugangsschlüssel",
    "This device needs its own Cloudflare Access service token. Create one in Cloudflare Zero Trust and enter its two parts here. They are kept in the keychain of this device only.": "Dieses Gerät braucht einen eigenen Service-Token für Cloudflare Access. Lege ihn in Cloudflare Zero Trust an und gib seine beiden Teile hier ein. Sie bleiben im Schlüsselbund dieses Geräts.",
    "Replace key": "Schlüssel ersetzen",
    "Check key": "Schlüssel prüfen",
    "Client ID": "Client-ID",
    "Client Secret": "Client-Secret",
    "Paste": "Einfügen",
    "Scan QR code": "QR-Code scannen",
    "Change server address": "Serveradresse ändern",
    "Second factor": "Zweiter Faktor",
    "Enter the code from your authenticator app, or one of your recovery codes.": "Gib den Code aus deiner Authenticator-App ein oder einen deiner Wiederherstellungscodes.",
    "Sign in": "Anmelden",
    "Code": "Code",
    "Back": "Zurück",
    "Add account": "Konto hinzufügen",
    "Sign in with your Mailflare account. You stay signed in on this device while you use it.": "Melde dich mit deinem Mailflare-Konto an. Du bleibst auf diesem Gerät angemeldet, solange du es benutzt.",
    "E-mail address": "E-Mail-Adresse",
    "Password": "Passwort",
    "Cancel": "Abbrechen",
    "Error: %@": "Fehler: %@",
    "Notice": "Hinweis",
    "OK": "OK",
    # Errors
    "No connection. Check the network and try again.": "Keine Verbindung. Prüfe das Netz und versuche es noch einmal.",
    "Access key rejected. Cloudflare Access did not let this device through.": "Zugangsschlüssel abgelehnt. Cloudflare Access hat dieses Gerät nicht durchgelassen.",
    "You have been signed out.": "Du wurdest abgemeldet.",
    "This no longer exists on the server.": "Das gibt es auf dem Server nicht mehr.",
    "Too many attempts. Try again in %lld seconds.": "Zu viele Versuche. Versuche es in %lld Sekunden noch einmal.",
    "E-mail address or password is wrong.": "E-Mail-Adresse oder Passwort ist falsch.",
    "The server reported an error (%lld).": "Der Server hat einen Fehler gemeldet (%lld).",
    "The server answered in a way this version of the app does not understand.": "Der Server hat so geantwortet, dass diese Version der App es nicht versteht.",
    "The saved sign-in could not be read. Set the app up again.": "Die gespeicherte Anmeldung konnte nicht gelesen werden. Richte die App neu ein.",
    "That is not a server address. Enter it like mail.example.com.": "Das ist keine Serveradresse. Gib sie so ein: mail.example.com.",
    "%@ was signed out on the server. Its mail was removed from this device.": "%@ wurde auf dem Server abgemeldet. Die Mails dieses Kontos wurden von diesem Gerät entfernt.",
    "The mail on this device could not be opened.": "Die Mails auf diesem Gerät konnten nicht geöffnet werden.",
    "That did not work. Try again.": "Das hat nicht geklappt. Versuche es noch einmal.",
    # Sync status
    "Updated just now": "Gerade aktualisiert",
    "Updated %lld min ago": "Aktualisiert vor %lld Min.",
    "Updated %lld h ago": "Aktualisiert vor %lld Std.",
    "Updated %@": "Aktualisiert %@",
    "Not synced yet": "Noch nicht abgeglichen",
    "First sync in progress …": "Erster Abgleich läuft …",
    "Updating …": "Wird aktualisiert …",
    "Offline · as of %@": "Offline · Stand %@",
    "Offline": "Offline",
    "Access key rejected": "Zugangsschlüssel abgelehnt",
    "Signed out": "Abgemeldet",
    "Sync failed": "Abgleich fehlgeschlagen",
    "yesterday, %@": "gestern, %@",
    "Yesterday": "Gestern",
    # Folders
    "Inbox": "Posteingang",
    "Promotions": "Werbung",
    "Social": "Soziales",
    "Invoices": "Rechnungen",
    "Orders": "Bestellungen",
    "Starred": "Markiert",
    "Snoozed": "Zurückgestellt",
    "Scheduled": "Geplant",
    "Sent": "Gesendet",
    "Drafts": "Entwürfe",
    "Spam": "Spam",
    "Trash": "Papierkorb",
    "All mail": "Alle Mails",
    "General": "Allgemein",
    # Mailboxes
    "Mailboxes": "Postfächer",
    "All mailboxes": "Alle Postfächer",
    "Mail": "Mail",
    "Folders": "Ordner",
    "More": "Mehr",
    "Calendar": "Kalender",
    "Drive": "Drive",
    "Settings": "Einstellungen",
    "Administration": "Verwaltung",
    "%@, %lld unread": "%@, %lld ungelesen",
    "Account: %@": "Konto: %@",
    # List
    "No recipient": "Kein Empfänger",
    "To: %@": "An: %@",
    "(No subject)": "(Kein Betreff)",
    "Show": "Anzeigen",
    "All": "Alle",
    "Unread": "Ungelesen",
    "Group conversations": "Unterhaltungen bündeln",
    "Filter": "Filter",
    "New mail": "Neue Mails",
    "Allowed": "Erlaubt",
    "Switched off": "Ausgeschaltet",
    "Not asked yet": "Noch nicht gefragt",
    "Allow notifications": "Mitteilungen erlauben",
    "Open the notification settings of iOS": "Mitteilungen in den iOS-Einstellungen öffnen",
    "Notifications": "Mitteilungen",
    "A notification shows sender, subject and the first lines. Archive, mark as read and delete work from the notification itself.": "Eine Mitteilung zeigt Absender, Betreff und die ersten Zeilen. Archivieren, als gelesen markieren und löschen gehen direkt in der Mitteilung.",
    "Search mail": "Mails durchsuchen",
    "On this device": "Auf diesem Gerät",
    "Older mail on the server": "Ältere Mails am Server",
    "Searching the server…": "Suche am Server …",
    "Without a connection only the mail on this device is searched.": "Ohne Verbindung wird nur in den Mails auf diesem Gerät gesucht.",
    "The server could not be searched.": "Am Server konnte nicht gesucht werden.",
    "Older mail loads when you are online again.": "Ältere Mails werden geladen, sobald du wieder online bist.",
    "Fetching your mail": "Deine Mails werden geholt",
    "The first sync brings the last days onto this device.": "Der erste Abgleich bringt die letzten Tage auf dieses Gerät.",
    "Nothing unread": "Nichts Ungelesenes",
    "No mail here": "Hier ist keine Mail",
    "Has attachments": "Mit Anhang",
    "%lld messages": "%lld Nachrichten",
    # Composing
    "To": "An",
    "Cc": "Cc",
    "Bcc": "Bcc",
    "From": "Von",
    "Cc/Bcc": "Cc/Bcc",
    "Subject": "Betreff",
    "New message": "Neue Mail",
    "Attach": "Anhängen",
    "Photo or video": "Foto oder Video",
    "File": "Datei",
    "Send": "Senden",
    "Keep this message?": "Diese Mail behalten?",
    "Save as draft": "Als Entwurf sichern",
    "Discard": "Verwerfen",
    "Include the earlier message": "Frühere Nachricht mitsenden",
    "This file is larger than 10 MB and cannot be attached.": "Diese Datei ist größer als 10 MB und kann nicht angehängt werden.",
    "A message can carry ten attachments at most.": "Eine Mail kann höchstens zehn Anhänge tragen.",
    "This file could not be read.": "Diese Datei konnte nicht gelesen werden.",
    "Photo": "Foto",
    "Remove %@": "%@ entfernen",
    "%@, remove": "%@, entfernen",
    "The attachments of the original are sent along.": "Die Anhänge der ursprünglichen Mail werden mitgesendet.",
    "Outbox": "Ausgang",
    "Nothing waiting": "Nichts im Ausgang",
    "Not sent: %@": "Nicht gesendet: %@",
    "Not sent": "Nicht gesendet",
    "Draft": "Entwurf",
    "Waiting to send": "Wartet auf Versand",
    "Reply": "Antworten",
    "Reply all": "Allen antworten",
    "Forward": "Weiterleiten",
    # Actions
    "Archive": "Archivieren",
    # The folder, as opposed to the action above. A key of its own with its English text.
    "folder.archive": ("Archive", "Archiv"),
    "Delete": "Löschen",
    "Delete for good": "Endgültig löschen",
    "Move to inbox": "In den Posteingang",
    "Mark as spam": "Als Spam markieren",
    "Mark as read": "Als gelesen markieren",
    "Mark as unread": "Als ungelesen markieren",
    "Star": "Markieren",
    "Remove star": "Markierung entfernen",
    "Snooze": "Zurückstellen",
    "Wake now": "Jetzt wieder vorlegen",
    "Move": "Verschieben",
    "This evening": "Heute Abend",
    "Tomorrow morning": "Morgen früh",
    "Next week": "Nächste Woche",
    "Snooze until": "Zurückstellen bis",
    "Delete for good?": "Endgültig löschen?",
    "This cannot be undone.": "Das lässt sich nicht rückgängig machen.",
    "Move to": "Verschieben nach",
    "Done": "Fertig",
    "Select": "Auswählen",
    "The server did not accept the last change (%@). The mail is back as it was.": "Der Server hat die letzte Änderung nicht angenommen (%@). Die Mail ist wieder so wie vorher.",
    # Reader
    "Cannot show this message": "Diese Nachricht kann nicht angezeigt werden",
    "Attachment": "Anhang",
    "Attachments": "Anhänge",
    "To: %@ and %lld more": "An: %@ und %lld weitere",
    "Reply to": "Antwort an",
    "Not on this device yet": "Noch nicht auf diesem Gerät",
    "This message loads as soon as you are online again.": "Diese Nachricht wird geladen, sobald du wieder online bist.",
    "Try again": "Erneut versuchen",
    "Load pictures from the internet": "Bilder aus dem Internet laden",
    "Hide quoted text": "Zitierten Text ausblenden",
    "Show quoted text": "Zitierten Text anzeigen",
    "Other messages of this conversation": "Weitere Nachrichten dieser Unterhaltung",
    # Web areas
    "Mailflare settings": "Mailflare-Einstellungen",
    "Cannot open this page": "Diese Seite kann nicht geöffnet werden",
    # App settings
    "Keep mail offline": "Mails offline behalten",
    "%lld days": "%lld Tage",
    "Fetch attachments up to 5 MB": "Anhänge bis 5 MB laden",
    "Only on Wi-Fi": "Nur im WLAN",
    "Mail from this period is on the device with its content. Older mail and larger attachments load when you open them.": "Mails aus diesem Zeitraum liegen mit Inhalt auf dem Gerät. Ältere Mails und größere Anhänge werden geladen, wenn du sie öffnest.",
    "Reading": "Lesen",
    "Haptic feedback": "Haptik",
    "Server": "Server",
    "Replace access key": "Zugangsschlüssel ersetzen",
    "Access": "Zugang",
    "If a key was revoked in Cloudflare, enter this device's new one here. Accounts and mail stay.": "Wurde ein Schlüssel in Cloudflare widerrufen, gib hier den neuen dieses Geräts ein. Konten und Mails bleiben erhalten.",
    "Accounts": "Konten",
    "Sign out": "Abmelden",
    "Signature, rules, security and everything else that belongs to your account opens as the web page for now.": "Signatur, Regeln, Sicherheit und alles Weitere zu deinem Konto öffnet sich vorerst als Webseite.",
    "Version": "Version",
    "Sign out?": "Abmelden?",
    "Signed-in devices": "Angemeldete Geräte",
    "%@ (this device)": "%@ (dieses Gerät)",
    "Signed in %@": "Angemeldet seit %@",
    "Sign a lost phone out here. Revoking its access key in Cloudflare cuts it off as well.": "Melde hier ein verlorenes Handy ab. Auch das Widerrufen seines Zugangsschlüssels in Cloudflare sperrt es aus.",
    "Sign this device out?": "Dieses Gerät abmelden?",
    "Sign out %@": "%@ abmelden",
    "The device is signed out at once. The mail already on it is removed the next time it reaches the server.": "Das Gerät wird sofort abgemeldet. Die Mails, die schon darauf liegen, werden entfernt, sobald es den Server das nächste Mal erreicht.",
    "Sign out and remove mail": "Abmelden und Mails entfernen",
    "The mail of %@ is removed from this device. It stays on the server.": "Die Mails von %@ werden von diesem Gerät entfernt. Auf dem Server bleiben sie erhalten.",
}


def catalog():
    strings = {}
    for key, value in sorted(GERMAN.items()):
        english, german = value if isinstance(value, tuple) else (key, value)
        strings[key] = {"localizations": {
            "de": {"stringUnit": {"state": "translated", "value": german}},
            "en": {"stringUnit": {"state": "translated", "value": english}},
        }}
    return {"sourceLanguage": "en", "strings": strings, "version": "1.0"}


def check(derived_data):
    found = set()
    for path in glob.glob(os.path.join(derived_data, "**", "*.stringsdata"), recursive=True):
        if "Mailflare.build" not in path:
            continue
        with open(path) as handle:
            for entries in json.load(handle).get("tables", {}).values():
                found.update(entry["key"] for entry in entries)
    # An empty text, as a field without a placeholder has, needs no translation.
    missing = sorted(key for key in found - set(GERMAN) if key.strip())
    for key in missing:
        print("no German text for:", json.dumps(key, ensure_ascii=False))
    return 1 if missing else 0


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        sys.exit(check(sys.argv[2]))
    with open(os.path.join(here, "..", "Mailflare", "Localizable.xcstrings"), "w") as handle:
        json.dump(catalog(), handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
