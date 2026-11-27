export type ProgressiveAvatarImageProps = {
	src: string;
	alt: string;
	className?: string;
	onError?: () => void;
	/** Called once something of the picture is on screen, the blurred preview included. */
	onLoad?: () => void;
	priority?: boolean;
};
