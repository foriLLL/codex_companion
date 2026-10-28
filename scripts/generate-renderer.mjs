import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { generateCardRegistry } from "./generate-card-registry.mjs";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function generateRenderer({ repoRoot = root, requireEntries = true } = {}) {
  await generateCardRegistry({ cardsDir: join(repoRoot, "src/cards"), outDir: join(repoRoot, "src"), requireEntries });
  const temporary = await mkdtemp(join(tmpdir(), "companion-renderer-build-"));
  try {
    const output = join(temporary, "renderer.js");
    await exec(join(repoRoot, "node_modules", "bun", "bin", "bun.exe"), ["build", join(repoRoot, "src/renderer/entry.mjs"),
      "--target=browser", "--format=iife", "--outfile", output], { cwd: repoRoot });
    const source = await readFile(output, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    const module = `// 构建产物；由 npm run generate:renderer 更新。\nexport const RENDERER_ARTIFACT_HASH = ${JSON.stringify(hash)};\nexport const RENDERER_SOURCE = ${JSON.stringify(source)};\n`;
    await writeFile(join(repoRoot, "src/renderer-embedded.generated.mjs"), module);
    return { hash, bytes: Buffer.byteLength(source) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await generateRenderer({ requireEntries: !process.argv.includes("--allow-missing") });
  console.log(`Renderer built: ${result.hash.slice(0, 16)} (${result.bytes} bytes)`);
}
