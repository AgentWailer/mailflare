export type ResizeHandleProps = {
	label: string;
	orientation?: "vertical" | "horizontal";
	onResizeStart?: () => void;
	onResize: (delta: number) => void;
	onResizeEnd?: () => void;
};
