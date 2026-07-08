import type { SourceFile } from "@rav/shared";

const SOURCE_EXTENSIONS = /\.(tsx|ts|jsx|js)$/i;
const IGNORED_PATH_PARTS = ["/node_modules/", "/dist/", "/build/", "/.git/"];

export async function readProjectFiles(fileList: FileList): Promise<SourceFile[]> {
  const files = [...fileList].filter((file) => {
    const path = getRelativePath(file);
    return SOURCE_EXTENSIONS.test(path) && !IGNORED_PATH_PARTS.some((part) => path.includes(part));
  });

  return Promise.all(
    files.map(async (file) => ({
      path: getRelativePath(file),
      content: await file.text()
    }))
  );
}

function getRelativePath(file: File): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, "/");
}
