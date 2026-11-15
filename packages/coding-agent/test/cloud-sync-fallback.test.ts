import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CLOUD_SYNC_URL,
	FALLBACK_CLOUD_SYNC_URLS,
	getSyncCandidateUrls,
	SyncCancelledError,
	syncAuthenticate,
	syncPush,
} from "../src/core/cloud-sync.ts";

describe("cloud-sync fallback mirror", () => {
	const origFetch = globalThis.fetch;
	const tempDirs: string[] = [];

	afterEach(() => {
		globalThis.fetch = origFetch;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns built-in fallback mirrors for default URL and leaves custom URLs alone", () => {
		const candidates = getSyncCandidateUrls(DEFAULT_CLOUD_SYNC_URL);
		expect(candidates[0]).toBe(DEFAULT_CLOUD_SYNC_URL);
		expect(candidates).toEqual([DEFAULT_CLOUD_SYNC_URL, ...FALLBACK_CLOUD_SYNC_URLS]);
		expect(getSyncCandidateUrls("https://custom.example.com/sync/")).toEqual(["https://custom.example.com/sync"]);
	});

	it("falls back to Cloudflare mirror when primary fails with network error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sync-fb-"));
		tempDirs.push(dir);
		const calls: string[] = [];
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url.startsWith(DEFAULT_CLOUD_SYNC_URL)) {
				throw new TypeError("fetch failed");
			}
			if (url.endsWith("/register")) {
				return new Response(JSON.stringify({ token: "a".repeat(64), user: "alice" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ updated: 12345 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const state = await syncAuthenticate("register", DEFAULT_CLOUD_SYNC_URL, "alice", "secret123", dir);
		expect(state.user).toBe("alice");
		expect(calls[0]).toBe(`${DEFAULT_CLOUD_SYNC_URL}/register`);
		expect(calls[1]).toBe(`${FALLBACK_CLOUD_SYNC_URLS[0]}/register`);

		const pushRes = await syncPush(dir);
		expect(pushRes.updated).toBe(12345);
	});

	it("does not fall back on HTTP 409 auth error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sync-409-"));
		tempDirs.push(dir);
		const calls: string[] = [];
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ error: "this login is already taken" }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await expect(syncAuthenticate("register", DEFAULT_CLOUD_SYNC_URL, "alice", "secret123", dir)).rejects.toThrow(
			"this login is already taken",
		);
		expect(calls).toHaveLength(1);
	});

	it("aborts immediately on external AbortSignal without trying fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sync-abort-"));
		tempDirs.push(dir);
		const controller = new AbortController();
		controller.abort();
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await expect(
			syncAuthenticate("register", DEFAULT_CLOUD_SYNC_URL, "alice", "secret123", dir, controller.signal),
		).rejects.toThrow(SyncCancelledError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
