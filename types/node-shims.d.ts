// Minimal ambient shims for the Node built-ins used by tests only (the project
// has no @types/node — src targets GraalJS, not Node). Kept intentionally tiny so
// it cannot leak Node APIs into the bundle's type surface.
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function writeFileSync(path: string, data: string): void;
	export function readdirSync(path: string): string[];
}
declare module "node:process" {
	export const env: Record<string, string | undefined>;
}
declare module "node:child_process" {
	export function execFileSync(
		file: string,
		args: readonly string[],
		options: { encoding: "utf8" },
	): string;
}
