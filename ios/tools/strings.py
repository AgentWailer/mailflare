#!/usr/bin/env python3
"""Writes Mailflare/Localizable.xcstrings from the table below.

English is the key, German the translation. After changing a text in the app, add or change
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
    "Archive": "Archiv",
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
    "Older mail loads when you are online again.": "Ältere Mails werden geladen, sobald du wieder online bist.",
    "Fetching your mail": "Deine Mails werden geholt",
    "The first sync brings the last days onto this device.": "Der erste Abgleich bringt die letzten Tage auf dieses Gerät.",
    "Nothing unread": "Nichts Ungelesenes",
    "No mail here": "Hier ist keine Mail",
    "Has attachments": "Mit Anhang",
    "%lld messages": "%lld Nachrichten",
}


def catalog():
    strings = {}
    for english, german in sorted(GERMAN.items()):
        strings[english] = {"localizations": {
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
    missing = sorted(found - set(GERMAN))
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
