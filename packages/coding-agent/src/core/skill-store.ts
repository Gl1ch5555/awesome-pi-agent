import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export type SkillManageAction = "create" | "patch" | "write_file" | "remove_file" | "delete";

export interface SkillManageInput {
	action: SkillManageAction;
	name: string;
	category?: string;
	content?: string;
	old_string?: string;
	new_string?: string;
	replace_all?: boolean;
	file_path?: string;
	file_content?: string;
}

export interface SkillManageResult {
	ok: boolean;
	summary: string;
	skillDir?: string;
	filePath?: string;
	error?: string;
}

const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALLOWED_SUPPORTING_PREFIXES = ["references/", "templates/", "scripts/", "assets/"];

function getSkillsRoot(agentDir: string): string {
	return join(agentDir, "skills");
}

function findSkillDir(skillsRoot: string, name: string): string | undefined {
	if (!existsSync(skillsRoot)) return undefined;
	const direct = join(skillsRoot, name);
	if (existsSync(join(direct, "SKILL.md"))) return direct;
	for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const nested = join(skillsRoot, entry.name, name);
		if (existsSync(join(nested, "SKILL.md"))) return nested;
	}
	return undefined;
}

function resolveSupportingPath(skillDir: string, filePath: string): { path?: string; error?: string } {
	const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized || normalized.includes("..")) {
		return { error: `Invalid supporting file_path "${filePath}": path traversal is not allowed.` };
	}
	if (!ALLOWED_SUPPORTING_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
		return {
			error: `Invalid supporting file_path "${filePath}": must start with references/, templates/, scripts/, or assets/.`,
		};
	}
	const resolved = resolve(skillDir, normalized);
	if (!resolved.startsWith(resolve(skillDir) + "/") && !resolved.startsWith(resolve(skillDir) + "\\")) {
		return { error: `Invalid supporting file_path "${filePath}".` };
	}
	return { path: resolved };
}

function validateSkillMarkdown(content: string): string | undefined {
	const trimmed = content.trim();
	if (!trimmed) return "Skill content cannot be empty.";
	const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(trimmed);
	if (!frontmatter || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
		return "SKILL.md must include YAML frontmatter with a non-empty 'description' field.";
	}
	if (!body.trim()) {
		return "SKILL.md must include a markdown body below the YAML frontmatter.";
	}
	return undefined;
}

export function applySkillManage(input: SkillManageInput, agentDir: string): SkillManageResult {
	const name = input.name?.trim();
	if (!name || !VALID_SKILL_NAME_RE.test(name)) {
		return {
			ok: false,
			summary: "",
			error: `Invalid skill name "${input.name ?? ""}". Use lowercase letters, digits, hyphens, or underscores (max 64 chars).`,
		};
	}

	const skillsRoot = getSkillsRoot(agentDir);
	const existingDir = findSkillDir(skillsRoot, name);

	if (input.action === "create") {
		if (existingDir) {
			return {
				ok: false,
				summary: "",
				error: `Skill "${name}" already exists at ${existingDir}. Use action="patch" to update it.`,
			};
		}
		const content = input.content ?? "";
		const validationError = validateSkillMarkdown(content);
		if (validationError) {
			return { ok: false, summary: "", error: validationError };
		}
		const category = input.category?.trim();
		if (category && !VALID_SKILL_NAME_RE.test(category)) {
			return { ok: false, summary: "", error: `Invalid category "${category}".` };
		}
		const targetDir = category ? join(skillsRoot, category, name) : join(skillsRoot, name);
		const skillFile = join(targetDir, "SKILL.md");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(skillFile, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
		return {
			ok: true,
			summary: `created skill "${name}"`,
			skillDir: targetDir,
			filePath: skillFile,
		};
	}

	if (!existingDir) {
		return {
			ok: false,
			summary: "",
			error: `Skill "${name}" not found under ${skillsRoot}. Use action="create" first.`,
		};
	}

	if (input.action === "delete") {
		rmSync(existingDir, { recursive: true, force: true });
		return {
			ok: true,
			summary: `deleted skill "${name}"`,
			skillDir: existingDir,
		};
	}

	if (input.action === "write_file") {
		if (!input.file_path) {
			return { ok: false, summary: "", error: "file_path is required for write_file." };
		}
		const resolved = resolveSupportingPath(existingDir, input.file_path);
		if (!resolved.path) {
			return { ok: false, summary: "", error: resolved.error };
		}
		mkdirSync(dirname(resolved.path), { recursive: true });
		writeFileSync(resolved.path, input.file_content ?? "", "utf-8");
		return {
			ok: true,
			summary: `wrote ${input.file_path} in skill "${name}"`,
			skillDir: existingDir,
			filePath: resolved.path,
		};
	}

	if (input.action === "remove_file") {
		if (!input.file_path) {
			return { ok: false, summary: "", error: "file_path is required for remove_file." };
		}
		const resolved = resolveSupportingPath(existingDir, input.file_path);
		if (!resolved.path) {
			return { ok: false, summary: "", error: resolved.error };
		}
		if (!existsSync(resolved.path)) {
			return { ok: false, summary: "", error: `File "${input.file_path}" not found in skill "${name}".` };
		}
		rmSync(resolved.path, { force: true });
		return {
			ok: true,
			summary: `removed ${input.file_path} from skill "${name}"`,
			skillDir: existingDir,
			filePath: resolved.path,
		};
	}

	// action === "patch"
	let targetFile = join(existingDir, "SKILL.md");
	if (input.file_path) {
		const resolved = resolveSupportingPath(existingDir, input.file_path);
		if (!resolved.path) {
			return { ok: false, summary: "", error: resolved.error };
		}
		targetFile = resolved.path;
	}
	if (!existsSync(targetFile)) {
		return { ok: false, summary: "", error: `Target file not found: ${targetFile}` };
	}

	const currentText = readFileSync(targetFile, "utf-8");
	let nextText: string;
	if (input.old_string !== undefined && input.new_string !== undefined) {
		const oldStr = input.old_string;
		if (!oldStr) {
			return { ok: false, summary: "", error: "old_string cannot be empty." };
		}
		const firstIdx = currentText.indexOf(oldStr);
		if (firstIdx === -1) {
			return {
				ok: false,
				summary: "",
				error: `old_string not found in ${input.file_path ?? "SKILL.md"}. Read the skill file first to match exact text.`,
			};
		}
		if (!input.replace_all) {
			const secondIdx = currentText.indexOf(oldStr, firstIdx + oldStr.length);
			if (secondIdx !== -1) {
				return {
					ok: false,
					summary: "",
					error: "old_string matched multiple times; provide more surrounding context or set replace_all=true.",
				};
			}
			nextText = currentText.slice(0, firstIdx) + input.new_string + currentText.slice(firstIdx + oldStr.length);
		} else {
			nextText = currentText.split(oldStr).join(input.new_string);
		}
	} else if (input.content !== undefined) {
		nextText = input.content;
	} else {
		return {
			ok: false,
			summary: "",
			error: "patch requires either (old_string + new_string) or content.",
		};
	}

	if (!input.file_path) {
		const validationError = validateSkillMarkdown(nextText);
		if (validationError) {
			return { ok: false, summary: "", error: validationError };
		}
	}

	writeFileSync(targetFile, nextText.endsWith("\n") ? nextText : `${nextText}\n`, "utf-8");
	return {
		ok: true,
		summary: `patched ${input.file_path ?? "SKILL.md"} in skill "${name}"`,
		skillDir: existingDir,
		filePath: targetFile,
	};
}
