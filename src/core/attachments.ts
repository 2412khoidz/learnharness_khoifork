/** Shared pure types & helpers for clipboard/phone image attachments. */

export const ATTACHMENT_NOTICE_EVENT = "lh:attachment-notice";

export interface AttachmentUploadResult {
	path: string;
	filename: string;
	mimeType: string;
	size: number;
	warning?: string;
}

export interface LanAddressCandidate {
	address: string;
	interfaceName: string;
	recommended: boolean;
}

export type PhoneTunnelStatus = "off" | "starting" | "ready" | "error";

export interface PhoneUploadEntry extends AttachmentUploadResult {
	index: number;
	receivedAt: number;
}

export interface PhoneUploadSessionInfo {
	sessionId: string;
	token: string;
	port: number;
	addresses: LanAddressCandidate[];
	defaultAddress: string | null;
	expiresAt: number;
	tunnelStatus?: PhoneTunnelStatus;
	tunnelUrl?: string | null;
	tunnelError?: string | null;
}

export interface PhoneUploadPollResponse {
	active: boolean;
	expiresAt: number;
	uploads: PhoneUploadEntry[];
	nextIndex: number;
	tunnelStatus?: PhoneTunnelStatus;
	tunnelUrl?: string | null;
	tunnelError?: string | null;
}

/** Build the mobile capture URL for a given LAN IPv4 host. */
export function buildPhoneUploadUrl(address: string, port: number, token: string): string {
	return `http://${address}:${port}/p/${encodeURIComponent(token)}`;
}

/** Build the mobile capture URL over a public HTTPS tunnel base URL. */
export function buildPhoneTunnelUploadUrl(tunnelBaseUrl: string, token: string): string {
	return `${tunnelBaseUrl.replace(/\/+$/, "")}/p/${encodeURIComponent(token)}`;
}

/** Extract real uploaded image Files/Blobs from a DataTransfer without touching mock text-only paste events. */
export function extractClipboardImageFiles(clipboardData: Pick<DataTransfer, "items" | "files"> | null | undefined): File[] {
	if (!clipboardData) return [];
	const out: File[] = [];
	const seen = new Set<File>();
	const items = clipboardData.items;
	if (items && typeof items.length === "number") {
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item || item.kind !== "file" || typeof item.getAsFile !== "function") continue;
			if (!item.type.startsWith("image/")) continue;
			const file = item.getAsFile();
			if (file && file.size > 0 && !seen.has(file)) {
				seen.add(file);
				out.push(file);
			}
		}
	}
	const files = clipboardData.files;
	if (files && typeof files.length === "number") {
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (file && file.type.startsWith("image/") && file.size > 0 && !seen.has(file)) {
				seen.add(file);
				out.push(file);
			}
		}
	}
	return out;
}
