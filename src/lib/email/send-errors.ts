/** Stable client-facing categories; messages remain compatible with existing API callers. */
export class DeliveryOutcomeError extends Error {
	constructor(readonly code: "delivery_unknown" | "delivery_status_pending", message: string) {
		super(message);
		this.name = "DeliveryOutcomeError";
	}
}
