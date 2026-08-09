/**
 * npm: specifier imports for cells.
 *
 * Bun's runtime does not resolve npm: specifiers, and letting cells `bun add`
 * would mutate the project the evaluator happens to be running in. Instead the
 * transform routes static npm: imports here: each name@version installs once
 * into its own directory under an isolated cache, and the module is imported by
 * absolute file URL from there. Resolution is delegated to Bun.resolveSync so
 * exports maps, conditions, and extension guessing behave exactly as they would
 * for a normal dependency — reimplementing that algorithm here would be a
 * permanent source of edge-case bugs.
 *
 * Concurrency is handled by publish-by-rename: installs happen in a staging
 * directory and are renamed into place, so a half-finished install is never
 * visible under the final path and concurrent installers (including other guest
 * processes) race harmlessly — the loser discards its staging copy.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface NpmSpecifier {
	/** Package name, including any scope: "zod", "@scope/pkg". */
	name: string;
	/** Version, range, or dist-tag; "latest" when unspecified. */
	version: string;
	/** Export subpath including its leading slash, or "" for the root. */
	subpath: string;
}

// The name is the security boundary: it becomes a dependency in a generated
// package.json and a specifier handed to the resolver, so only plain npm name
// characters are accepted — no separators that could re-route either one.
const NAME_PART = String.raw`[a-zA-Z0-9~][a-zA-Z0-9._~-]*`;
const SPECIFIER_PATTERN = new RegExp(`^npm:((?:@${NAME_PART}/)?${NAME_PART})(?:@([^/\\\\]+))?((?:/.*)?)$`);

export function parseNpmSpecifier(specifier: string): NpmSpecifier {
	const match = SPECIFIER_PATTERN.exec(specifier);
	if (!match) {
		throw new Error(
			`Cannot parse "${specifier}" as an npm specifier. Expected npm:package, npm:package@version, ` +
				`or npm:@scope/package@version, with an optional /subpath.`,
		);
	}
	return { name: match[1], version: match[2] ?? "latest", subpath: match[3] };
}

function cacheRoot(): string {
	return (
		process.env.PI_RLM_NPM_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-rlm-npm")
	);
}

/**
 * Directory name for one name@version. The readable prefix is sanitised (so
 * "@scope/pkg" cannot introduce a path segment) and therefore lossy; the hash
 * of the unsanitised pair keeps distinct inputs from colliding after cleanup.
 */
function installDirName(name: string, version: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(`${name}@${version}`).digest("hex").slice(0, 16);
	const readable = `${name}@${version}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return `${readable}-${digest}`;
}

async function installPackage(name: string, version: string): Promise<string> {
	const root = join(cacheRoot(), installDirName(name, version));
	const installedMarker = join(root, "node_modules", name, "package.json");
	if (await Bun.file(installedMarker).exists()) return root;

	const staging = `${root}.staging-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	try {
		await mkdir(staging, { recursive: true });
		await Bun.write(
			join(staging, "package.json"),
			`${JSON.stringify({ name: "pi-rlm-npm-cache", private: true, dependencies: { [name]: version } }, null, "\t")}\n`,
		);
		const install = Bun.spawn(["bun", "install", "--no-progress"], { cwd: staging, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(install.stdout).text(),
			new Response(install.stderr).text(),
			install.exited,
		]);
		if (exitCode !== 0) {
			throw new Error(`bun install failed for ${name}@${version} (exit ${exitCode}):\n${stderr || stdout}`);
		}
		try {
			await rename(staging, root);
		} catch (error) {
			// A concurrent installer published first; its copy is equivalent.
			if (!(await Bun.file(installedMarker).exists())) throw error;
		}
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}

	if (!(await Bun.file(installedMarker).exists())) {
		throw new Error(`bun install succeeded but did not produce ${name}@${version} in ${root}`);
	}
	return root;
}

// Deduplicates concurrent installs of the same name@version within this
// process. Failed installs are evicted so a later cell can retry — a poisoned
// entry would otherwise make one transient network error permanent for the
// whole session.
const installs = new Map<string, Promise<string>>();

function ensureInstalled(name: string, version: string): Promise<string> {
	const key = `${name}@${version}`;
	let task = installs.get(key);
	if (!task) {
		task = installPackage(name, version);
		task.catch(() => installs.delete(key));
		installs.set(key, task);
	}
	return task;
}

export async function importNpm(specifier: string): Promise<unknown> {
	const { name, version, subpath } = parseNpmSpecifier(specifier);
	const root = await ensureInstalled(name, version);
	const entry = Bun.resolveSync(name + subpath, root);
	return await import(pathToFileURL(entry).href);
}
