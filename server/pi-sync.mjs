#!/usr/bin/env node
// pi-sync: account + encrypted cloud sync server for awesome-pi-agent.
// Zero external dependencies, Node 22+.
// Endpoints:
//   GET  /          -> { ok: true, service: "pi-sync" }
//   POST /register  -> { token, user }
//   POST /login     -> { token, user }
//   POST /logout    -> { ok: true }
//   GET  /data      -> { data, updated }
//   PUT  /data      -> { updated }

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PI_SYNC_PORT) || 8772;
const HOST = process.env.PI_SYNC_HOST || "127.0.0.1";
const DATA_DIR = path.resolve(process.env.PI_SYNC_DATA || "/var/lib/pi-sync");
const MAX_BODY = 16 * 1024 * 1024;
const MAX_TOKENS = 25;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const KEY_FILE = path.join(DATA_DIR, ".server-key");
function loadOrCreateMasterKey() {
	if (fs.existsSync(KEY_FILE)) {
		const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
		if (/^[0-9a-f]{64}$/i.test(raw)) {
			return Buffer.from(raw, "hex");
		}
	}
	const key = crypto.randomBytes(32);
	fs.writeFileSync(KEY_FILE, key.toString("hex"), { mode: 0o600 });
	return key;
}

const MASTER_KEY = loadOrCreateMasterKey();

function encryptPayload(obj) {
	if (obj == null) return null;
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
	const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 1,
		iv: iv.toString("hex"),
		tag: tag.toString("hex"),
		ct: encrypted.toString("base64"),
	};
}

function decryptPayload(raw) {
	if (raw == null) return null;
	if (typeof raw === "object" && raw.v === 1 && raw.iv && raw.tag && raw.ct) {
		const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, Buffer.from(raw.iv, "hex"));
		decipher.setAuthTag(Buffer.from(raw.tag, "hex"));
		const decrypted = Buffer.concat([decipher.update(Buffer.from(raw.ct, "base64")), decipher.final()]);
		return JSON.parse(decrypted.toString("utf8"));
	}
	return raw;
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const accountFile = (user) => path.join(DATA_DIR, `${sha256(user.toLowerCase())}.json`);

function loadAccount(user) {
	try {
		return JSON.parse(fs.readFileSync(accountFile(user), "utf8"));
	} catch {
		return null;
	}
}

function saveAccount(acc) {
	const file = accountFile(acc.user);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(acc), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

const hashPass = (pass, salt) => crypto.scryptSync(pass, salt, 32).toString("hex");

function issueToken(acc) {
	const token = crypto.randomBytes(32).toString("hex");
	acc.tokens = [...(acc.tokens || []), sha256(token)].slice(-MAX_TOKENS);
	return token;
}

const attempts = new Map();
function isRateLimited(ip) {
	const now = Date.now();
	const entry = attempts.get(ip);
	if (!entry || now - entry.ts > 600_000) {
		attempts.set(ip, { count: 1, ts: now });
		return false;
	}
	return ++entry.count > 30;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("payload too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(new Error("invalid json"));
			}
		});
		req.on("error", reject);
	});
}

function authenticate(req) {
	const match = /^Bearer ([^:\s]+):([0-9a-f]{64})$/.exec(req.headers.authorization || "");
	if (!match) return null;
	const acc = loadAccount(match[1]);
	if (!acc || !Array.isArray(acc.tokens)) return null;
	return acc.tokens.includes(sha256(match[2])) ? acc : null;
}

const server = http.createServer(async (req, res) => {
	const send = (status, payload) => {
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(JSON.stringify(payload));
	};

	const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
	const pathname = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";

	try {
		if (req.method === "GET" && pathname === "/") {
			return send(200, { ok: true, service: "pi-sync", version: 1 });
		}

		if (req.method === "POST" && (pathname === "/register" || pathname === "/login")) {
			if (isRateLimited(ip)) {
				return send(429, { error: "too many attempts, try again in 10 minutes" });
			}
			const { user, pass } = await readJsonBody(req);
			if (typeof user !== "string" || !/^[\w.@+-]{2,64}$/.test(user)) {
				return send(400, { error: "login: 2-64 chars (letters, digits, _ . @ + -)" });
			}
			if (typeof pass !== "string" || pass.length < 4 || pass.length > 256) {
				return send(400, { error: "password: at least 4 characters" });
			}

			let acc = loadAccount(user);
			if (pathname === "/register") {
				if (acc) return send(409, { error: "this login is already taken" });
				const salt = crypto.randomBytes(16).toString("hex");
				acc = {
					user,
					salt,
					hash: hashPass(pass, salt),
					tokens: [],
					encryptedData: null,
					updated: 0,
					created: Date.now(),
				};
			} else {
				if (!acc) return send(404, { error: "unknown account" });
				const expected = Buffer.from(acc.hash, "hex");
				const actual = Buffer.from(hashPass(pass, acc.salt), "hex");
				if (expected.length !== actual.length || !crypto.timingSafeEqual(actual, expected)) {
					return send(401, { error: "wrong password" });
				}
			}

			const token = issueToken(acc);
			saveAccount(acc);
			return send(200, { token, user: acc.user });
		}

		const acc = authenticate(req);
		if (!acc) {
			return send(401, { error: "not signed in" });
		}

		if (req.method === "POST" && pathname === "/logout") {
			const rawToken = /:([0-9a-f]{64})$/.exec(req.headers.authorization || "")?.[1];
			if (rawToken) {
				const hashed = sha256(rawToken);
				acc.tokens = (acc.tokens || []).filter((t) => t !== hashed);
				saveAccount(acc);
			}
			return send(200, { ok: true });
		}

		if (req.method === "GET" && pathname === "/data") {
			const data = decryptPayload(acc.encryptedData ?? null);
			return send(200, { data, updated: acc.updated || 0 });
		}

		if (req.method === "PUT" && pathname === "/data") {
			const { data } = await readJsonBody(req);
			if (!data || typeof data !== "object" || Array.isArray(data)) {
				return send(400, { error: "data must be an object" });
			}
			acc.encryptedData = encryptPayload(data);
			acc.updated = Math.max(Date.now(), (acc.updated || 0) + 1);
			saveAccount(acc);
			return send(200, { updated: acc.updated });
		}

		return send(404, { error: "not found" });
	} catch (error) {
		const msg = error instanceof Error ? error.message : "bad request";
		return send(msg === "payload too large" ? 413 : 400, { error: msg });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`pi-sync listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
});
