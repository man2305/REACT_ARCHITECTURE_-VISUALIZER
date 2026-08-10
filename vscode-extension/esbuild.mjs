import * as esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: "external",
  target: "es2020",
  logLevel: "info",
  alias: {
    "@rav/parser": path.join(root, "packages/parser/src/index.ts"),
    "@rav/shared": path.join(root, "packages/shared/src/index.ts")
  }
};

const extensionConfig = {
  ...shared,
  entryPoints: [path.join(__dirname, "src/extension.ts")],
  outfile: path.join(__dirname, "dist/extension.js"),
  format: "cjs",
  platform: "node",
  external: ["vscode"]
};

const webviewConfig = {
  ...shared,
  entryPoints: [path.join(__dirname, "src/webview/main.tsx")],
  outfile: path.join(__dirname, "dist/webview.js"),
  format: "iife",
  platform: "browser",
  loader: { ".css": "css" },
  jsx: "automatic"
};

if (watch) {
  const extensionContext = await esbuild.context(extensionConfig);
  const webviewContext = await esbuild.context(webviewConfig);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig)
  ]);
}
