"use client";

import { useEffect, useState } from "react";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { CONTACT_AVATAR_CHANGED_EVENT } from "@/lib/contacts/avatar-client";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";
import type { ContactAvatarProps } from "./contact-avatar-types";
import {
	getContactAvatarInitial,
	getManagedContactAvatarUrl,
} from "./contact-avatar-utils";

// Literal white, not the palette's: the dark theme turns `bg-white` into a dark surface, and a dark
// logo on a transparent ground would vanish on it. Bundled logos carry the same white themselves.
const LOGO_GROUND = { backgroundColor: "#ffffff" };

export function ContactAvatar(props: ContactAvatarProps) {
	// Reset errors and local photo edits when the actual image identity changes.
	const identity = JSON.stringify([props.mailboxId, normalizeEmailAddress(props.address), props.hasManagedAvatar ?? false, props.managedAvatarUrl, props.fallbackAvatarUrl]);
	return <ContactAvatarContent key={identity} {...props} />;
}

function ContactAvatarContent({
	mailboxId,
	address,
	name,
	hasManagedAvatar = false,
	managedAvatarUrl,
	fallbackAvatarUrl,
	className,
	priority = false,
}: ContactAvatarProps) {
	const [managedAvatar, setManagedAvatar] = useState(hasManagedAvatar);
	const [imageFailed, setImageFailed] = useState(false);
	const [avatarVersion, setAvatarVersion] = useState(0);
	// The picture that is on screen. Until it is, the coloured initial stands in for it.
	const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

	useEffect(() => {
		function onAvatarChanged(event: Event) {
			const detail = (event as CustomEvent<{ email?: string; hasAvatar?: boolean }>).detail;
			if (detail?.email === normalizeEmailAddress(address)) {
				setManagedAvatar(!!detail.hasAvatar);
				setAvatarVersion(Date.now());
				setImageFailed(false);
			}
		}

		window.addEventListener(CONTACT_AVATAR_CHANGED_EVENT, onAvatarChanged);
		return () => window.removeEventListener(CONTACT_AVATAR_CHANGED_EVENT, onAvatarChanged);
	}, [address]);

	// Resolve synchronously, so cached logos are available on the very first render.
	const managedSource = managedAvatarUrl || (managedAvatar && mailboxId
		? getManagedContactAvatarUrl(mailboxId, address, avatarVersion) : null);
	const avatarUrl = managedSource || fallbackAvatarUrl;
	function onImageError() {
		if (managedAvatarUrl) setImageFailed(true);
		else if (managedAvatar) setManagedAvatar(false);
		else setImageFailed(true);
	}

	// A logo is often a shape on a transparent ground. Once it is shown, the initial and its colour
	// would show through it, so they give way to the white ground logos are drawn for.
	const pictureShown = !!avatarUrl && !imageFailed && loadedUrl === avatarUrl;

	return (
		<span
			className={cn("relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700", className)}
			style={pictureShown ? LOGO_GROUND : getAvatarColorStyle(normalizeEmailAddress(address) || name)}
			data-avatar-picture={pictureShown ? "" : undefined}
			aria-hidden
		>
			{pictureShown ? null : getContactAvatarInitial(name, address)}
			{avatarUrl && !imageFailed && (managedSource ? (
				<ProgressiveAvatarImage
					key={avatarUrl}
					src={avatarUrl}
					alt=""
					priority={priority}
					className="absolute inset-0 h-full w-full object-cover"
					onError={onImageError}
					onLoad={() => setLoadedUrl(avatarUrl)}
				/>
			) : (
				// Logos are already small: use the same URL in the list and reader.
				// eslint-disable-next-line @next/next/no-img-element
				<img
					key={avatarUrl}
					src={avatarUrl}
					alt=""
					loading={priority ? "eager" : "lazy"}
					fetchPriority={priority ? "high" : "auto"}
					decoding="async"
					className="absolute inset-0 h-full w-full object-cover"
					onError={onImageError}
					onLoad={() => setLoadedUrl(avatarUrl)}
				/>
			))}
		</span>
	);
}
