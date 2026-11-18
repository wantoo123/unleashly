import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const version = readFileSync("VERSION", "utf8").trim();
if (!version) throw new Error("VERSION is empty");

const changelog = readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const match = changelog.match(new RegExp(`##\\s*${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
const notes = match?.[1]?.trim() || `Unleashly ${version}`;

mkdirSync("release", { recursive: true });
writeFileSync("release/release-notes.md", `${notes}\n`, "utf8");
console.log(`Release notes for ${version}:\n${notes}`);
