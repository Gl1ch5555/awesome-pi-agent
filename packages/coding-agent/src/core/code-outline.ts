import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export interface OutlineSymbol {
	line: number;
	text: string;
}

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"coverage",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".cache",
]);

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".cs",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".rb",
	".php",
	".md",
]);

const CONTROL_FLOW_KEYWORDS = new Set([
	"if",
	"else",
	"for",
	"while",
	"switch",
	"case",
	"catch",
	"try",
	"finally",
	"return",
	"throw",
	"new",
	"await",
	"typeof",
	"delete",
]);

function trimSignature(line: string, maxLen = 96): string {
	const cleaned = line
		.replace(/\s*\{[\s\S]*$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLen) return cleaned;
	return `${cleaned.slice(0, maxLen - 1)}…`;
}

export function extractSymbolsFromContent(content: string, ext: string, maxSymbols = 120): OutlineSymbol[] {
	const lines = content.split(/\r?\n/);
	const symbols: OutlineSymbol[] = [];
	const lowerExt = ext.toLowerCase();

	for (let i = 0; i < lines.length; i++) {
		if (symbols.length >= maxSymbols) break;
		const raw = lines[i]!;
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			continue;
		}
		const lineNo = i + 1;

		if (lowerExt === ".md" || lowerExt === ".mdx") {
			if (/^#{1,3}\s+\S/.test(trimmed)) {
				symbols.push({ line: lineNo, text: trimSignature(trimmed) });
			}
			continue;
		}

		if (lowerExt === ".py") {
			if (/^(?:async\s+def|def|class)\s+[A-Za-z_][A-Za-z0-9_]*/.test(trimmed)) {
				const indent = raw.search(/\S/);
				const prefix = indent > 0 ? "  " : "";
				symbols.push({ line: lineNo, text: `${prefix}${trimSignature(trimmed.replace(/:\s*$/, ""))}` });
			}
			continue;
		}

		if (lowerExt === ".go") {
			if (/^(?:func|type)\s+/.test(trimmed)) {
				symbols.push({ line: lineNo, text: trimSignature(trimmed) });
			}
			continue;
		}

		if (lowerExt === ".rs") {
			if (/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|type)\s+/.test(trimmed)) {
				symbols.push({ line: lineNo, text: trimSignature(trimmed) });
			}
			continue;
		}

		// TS / JS / Java / C# / C++ / PHP / Ruby
		if (
			/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(?:declare\s+)?(?:async\s+)?(?:class|interface|type|enum|function|struct|namespace|module)\s+[A-Za-z_$]/.test(
				trimmed,
			)
		) {
			symbols.push({ line: lineNo, text: trimSignature(trimmed) });
			continue;
		}

		if (/^(?:export\s+)?const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.test(trimmed)) {
			symbols.push({ line: lineNo, text: trimSignature(trimmed.replace(/\s*=>[\s\S]*$/, "")) });
			continue;
		}

		// Class methods (indented, e.g. `private async showModelSelector(...): void {`)
		const indent = raw.search(/\S/);
		if (indent >= 1 && indent <= 6) {
			const methodMatch = trimmed.match(
				/^(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]+>)?\s*\([^;]*\)\s*(?::\s*[^{]+)?\{/,
			);
			if (methodMatch && !CONTROL_FLOW_KEYWORDS.has(methodMatch[1]!)) {
				symbols.push({ line: lineNo, text: `  ${trimSignature(trimmed)}` });
			}
		}
	}

	return symbols;
}

export function outlineFile(filePath: string, cwd?: string, maxSymbols = 120): string {
	const abs = resolve(cwd ?? process.cwd(), filePath);
	const display = cwd ? relative(cwd, abs) || abs : abs;
	const content = readFileSync(abs, "utf8");
	const lineCount = content.split(/\r?\n/).length;
	const symbols = extractSymbolsFromContent(content, extname(abs), maxSymbols);
	if (symbols.length === 0) {
		return `${display} (${lineCount} lines): (no top-level symbols detected)`;
	}
	const lines = [`${display} (${lineCount} lines):`];
	for (const sym of symbols) {
		lines.push(`  L${sym.line} ${sym.text}`);
	}
	return lines.join("\n");
}

function collectCodeFiles(dir: string, maxFiles: number, maxDepth: number, depth = 0, out: string[] = []): string[] {
	if (depth > maxDepth || out.length >= maxFiles) return out;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (out.length >= maxFiles) break;
		if (entry.name.startsWith(".") && entry.name !== ".github") continue;
		if (entry.isDirectory()) {
			if (!IGNORED_DIRS.has(entry.name)) {
				collectCodeFiles(join(dir, entry.name), maxFiles, maxDepth, depth + 1, out);
			}
		} else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
			out.push(join(dir, entry.name));
		}
	}
	return out;
}

export function outlinePath(
	targetPath: string,
	cwd: string,
	options: { maxFiles?: number; maxDepth?: number; maxSymbolsPerFile?: number } = {},
): string {
	const abs = resolve(cwd, targetPath || ".");
	if (!existsSync(abs)) {
		throw new Error(`Path not found: ${targetPath}`);
	}
	const st = statSync(abs);
	if (st.isFile()) {
		return outlineFile(abs, cwd, options.maxSymbolsPerFile ?? 120);
	}
	const files = collectCodeFiles(abs, options.maxFiles ?? 30, options.maxDepth ?? 4);
	if (files.length === 0) {
		return `No supported source files found under ${relative(cwd, abs) || "."}`;
	}
	const sections: string[] = [];
	const perFileLimit = Math.min(options.maxSymbolsPerFile ?? 18, 25);
	for (const file of files) {
		try {
			const size = statSync(file).size;
			if (size > 512 * 1024) continue;
			sections.push(outlineFile(file, cwd, perFileLimit));
		} catch {
			// skip unreadable
		}
	}
	return sections.join("\n\n");
}
