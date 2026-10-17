"use client";

import { lazy, Suspense, type ComponentProps } from "react";

const ProfileForm = lazy(() => import("./profile-form").then(module => ({ default: module.ProfileForm })));
const ForwardingEmailForm = lazy(() => import("./forwarding-email-form").then(module => ({ default: module.ForwardingEmailForm })));
const MailboxSignatureForm = lazy(() => import("./mailbox-signature-form").then(module => ({ default: module.MailboxSignatureForm })));
const TimeZoneForm = lazy(() => import("./time-zone-form").then(module => ({ default: module.TimeZoneForm })));
const WritingPreferencesSettings = lazy(() => import("./writing-preferences-settings").then(module => ({ default: module.WritingPreferencesSettings })));

export function DeferredProfileForm(props: ComponentProps<typeof ProfileForm>) {
	return <Suspense fallback={null}><ProfileForm {...props} /></Suspense>;
}
export function DeferredForwardingEmailForm(props: ComponentProps<typeof ForwardingEmailForm>) {
	return <Suspense fallback={null}><ForwardingEmailForm {...props} /></Suspense>;
}
export function DeferredMailboxSignatureForm() {
	return <Suspense fallback={null}><MailboxSignatureForm /></Suspense>;
}
export function DeferredTimeZoneForm(props: ComponentProps<typeof TimeZoneForm>) {
	return <Suspense fallback={null}><TimeZoneForm {...props} /></Suspense>;
}

export function DeferredWritingPreferencesSettings() {
	return <Suspense fallback={null}><WritingPreferencesSettings /></Suspense>;
}
