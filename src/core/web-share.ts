import type { LanAddressCandidate } from "./attachments.ts";

export type WebShareTunnelStatus = "idle" | "starting" | "ready" | "error";

export interface WebShareSessionInfo {
	active: boolean;
	remoteClient?: boolean;
	sessionId?: string;
	token?: string;
	port?: number;
	addresses?: LanAddressCandidate[];
	recommendedAddress?: string | null;
	tunnelStatus: WebShareTunnelStatus;
	tunnelUrl: string | null;
	tunnelError: string | null;
	shareUrl: string | null;
	lanShareUrl: string | null;
	expiresAt?: number;
	lastClientAt?: number | null;
}

/** Build the public HTTPS Web Share URL from the tunnel base URL and pairing token. */
export function buildWebShareTunnelUrl(tunnelBaseUrl: string, token: string): string {
	return `${tunnelBaseUrl.replace(/\/+$/, "")}/__share/${encodeURIComponent(token)}`;
}

/** Build the same-Wi-Fi LAN Web Share URL from a host IPv4 address, proxy port, and pairing token. */
export function buildWebShareLanUrl(address: string, port: number, token: string): string {
	return `http://${address}:${port}/__share/${encodeURIComponent(token)}`;
}
